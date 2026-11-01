import { spawn, execFile, execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { assertSupportedNodeRuntime } from "../../tooling/environment/node-runtime.mjs";

assertSupportedNodeRuntime();

export function sanitizeDiagnostic(text) {
  return String(text).replace(/agentrelay_[a-f0-9]{64}/gi, "[redacted-token]")
    .replace(/(MF-Proxy-Shared-Secret["']?\s*:\s*["'])[^"']+/gi, "$1[redacted]")
    .replace(/(MF-Proxy-Shared-Secret:\s*)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]");
}

/** Wrangler writes its own files as well as stdout; sanitize both before retaining a run. */
export function sanitizeRunLogs(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) sanitizeRunLogs(file);
    else if (item.isFile() && item.name.endsWith(".log")) {
      const original = readFileSync(file, "utf8"), sanitized = sanitizeDiagnostic(original);
      if (original !== sanitized) writeFileSync(file, sanitized);
    }
  }
}

/** Preserve known CLI error codes, including JSON errors on stdout, without retaining SQL or row data. */
function subprocessFailure(error, stdout, stderr) {
  const output = `${stdout ?? ""}\n${stderr ?? ""}`;
  const outputCodes = ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_ERROR", "SQLITE_CANTOPEN", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_CONSTRAINT", "SQLITE_CORRUPT"]
    .filter(code => output.includes(code));
  const failure = new Error(`Integration subprocess failed: ${JSON.stringify({ code: error.code ?? null, status: error.status ?? error.code, signal: error.signal,
    outputCodes, stdoutBytes: Buffer.byteLength(stdout ?? ""), stderrBytes: Buffer.byteLength(stderr ?? "") })}`);
  failure.stderr = sanitizeDiagnostic(stderr ?? "");
  return failure;
}

/** Bound local CLI fixture operations without exposing SQL arguments in thrown command errors. */
export function execTestFileSync(file, args, options = {}) {
  try { return execFileSync(file, args, { windowsHide: true, timeout: 60_000, ...options }); }
  catch (error) {
    throw subprocessFailure(error, error.stdout, error.stderr);
  }
}

/**
 * Async twin of execTestFileSync. Fixtures that run between HTTP requests must use this one: a synchronous call blocks the
 * event loop, so the connection pool cannot retire sockets the Worker has already closed.
 */
export function execTestFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, encoding: "buffer", ...options }, (error, stdout, stderr) => {
      if (!error) return resolve(options.encoding && options.encoding !== "buffer" ? String(stdout) : stdout);
      reject(subprocessFailure(error, stdout, stderr));
    });
  });
}

/** Async twin of spawnTestSync with the same result shape: a non-zero exit is a result, not an exception. */
export function spawnTest(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, maxBuffer: 64 << 20, ...options }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, signal: error?.signal ?? null, error: error && typeof error.code !== "number" ? error : undefined, stdout, stderr });
    });
  });
}

export function spawnTestSync(file, args, options = {}) {
  return spawnSync(file, args, { windowsHide: true, timeout: 60_000, ...options });
}

/** Own one process tree, retain sanitized output, and enforce a wall-clock deadline. */
export function startTestNode(args, { env = process.env, cwd = projectRoot, logFile, label = "node", timeoutMs = 120_000, onOutput, signal } = {}) {
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const started = performance.now();
  let tail = "", timedOut = false;
  const emit = value => {
    if (!value) return;
    const text = sanitizeDiagnostic(value);
    tail = (tail + text).slice(-8_000);
    if (logFile) appendFileSync(logFile, text);
    onOutput?.(text);
  };
  // Redact complete lines so a credential split between stream chunks cannot bypass filtering.
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    stream.on("data", chunk => {
      pending += decoder.write(chunk);
      const end = pending.lastIndexOf("\n");
      if (end >= 0) { emit(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    });
    stream.once("end", () => { emit(pending + decoder.end()); pending = ""; });
  }
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    // Windows does not propagate kill() to Wrangler's workerd/esbuild descendants.
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const exit = new Promise(resolve => {
    child.once("error", error => resolve({ label, code: null, error: error.code, elapsedMs: Math.round(performance.now() - started), timedOut }));
    child.once("exit", (code, signal) => resolve({ label, code, signal, elapsedMs: Math.round(performance.now() - started), timedOut }));
  });
  const done = new Promise(resolve => {
    child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve({ label, code: null, error: error.code, elapsedMs: Math.round(performance.now() - started), timedOut }); });
    // close follows stdout/stderr end, so callers can safely inspect the final summary.
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ label, code, signal: exitSignal, elapsedMs: Math.round(performance.now() - started), timedOut });
    });
  });
  return { child, exit, done, stop, get tail() { return tail; } };
}

export async function runTestNode(args, options) {
  const process = startTestNode(args, options);
  const result = await process.done;
  if (result.code !== 0 || result.timedOut || result.error) {
    const failure = new Error(`Integration process failed: ${JSON.stringify(result)}\n${process.tail}`);
    failure.result = result;
    throw failure;
  }
  return result;
}
