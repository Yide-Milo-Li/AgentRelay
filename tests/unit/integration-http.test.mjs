import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { getEventListeners } from "node:events";
import test from "node:test";
import { testRequest } from "../support/integration-http.mjs";
import { execTestFile, execTestFileSync, sanitizeDiagnostic, startTestNode } from "../support/integration-process.mjs";

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const stage of ["headers", "body"]) {
  test(`a hanging response has a bounded ${stage} deadline`, async t => {
    const url = await endpoint(t, (_, response) => {
      if (stage === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); }
    });
    await assert.rejects(testRequest(url, {}, { timeoutMs: 150, label: `hanging-${stage}` }), error => {
      assert.equal(error.details.category, "timeout");
      assert.equal(error.details.attempt, 1);
      assert.equal(error.details.check, `hanging-${stage}`);
      assert.ok(error.details.elapsedMs < 2_000);
      return true;
    });
  });
}

test("a proxy 503 is classified before JSON parsing without exposing response text", async t => {
  const secret = `agentrelay_${"a".repeat(64)}`;
  const url = await endpoint(t, (_, response) => {
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end(`Your worker restarted mid-request ${secret}`);
  });
  await assert.rejects(testRequest(`${url}/api/handoffs/private-id?token=${secret}`), error => {
    assert.equal(error.details.category, "proxy-restart");
    assert.equal(error.details.status, 503);
    assert.equal(error.details.route, "/api/handoffs/:id");
    assert.ok(!String(error).includes(secret) && !String(error).includes("private-id"));
    return true;
  });
});

test("malformed JSON reports its category without copying the body", async t => {
  const url = await endpoint(t, (_, response) => response.end("private response text"));
  await assert.rejects(testRequest(url), error => error.details.category === "invalid-json" && !error.message.includes("private response text"));
});

test("ordinary HTTP rejections remain assertable and text downloads preserve bytes", async t => {
  const text = "exact\r\n 中文 🚀\n";
  const url = await endpoint(t, (request, response) => {
    if (request.url === "/denied") { response.writeHead(401, { "Content-Type": "application/json" }); response.end('{"error":"sign in"}'); }
    else { response.writeHead(200, { "Content-Type": "text/plain" }); response.end(text); }
  });
  assert.equal((await testRequest(`${url}/denied`)).status, 401);
  const download = await testRequest(url, {}, { format: "text" });
  assert.equal(download.text, text);
  assert.deepEqual(download.bytes, new Uint8Array(Buffer.from(text)));
});

for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
  test(`an ambiguous ${method} connection loss is never replayed`, async t => {
    let calls = 0, observed;
    const url = await endpoint(t, (request) => {
      calls++;
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { observed = body; request.socket.destroy(); });
    });
    const body = method === "GET" ? undefined : JSON.stringify({ requestKey: "original-key", version: 1 });
    await assert.rejects(testRequest(url, { method, body }), error => error.details.category === "transport");
    assert.equal(calls, 1);
    assert.equal(observed, body ?? "");
  });
}

test("suites that run fixtures between requests use the non-blocking helpers", () => {
  // execFileSync blocks the event loop for seconds, so a pooled socket the Worker closed meanwhile fails the next request with ECONNRESET.
  for (const suite of ["agents", "attachments", "storage", "projects"]) {
    const source = readFileSync(new URL(`../integration/verify-agentrelay-${suite}.mjs`, import.meta.url), "utf8");
    assert.ok(!/execTestFileSync|spawnTestSync|execFileSync|spawnSync/.test(source), `${suite} must not block the event loop between requests`);
  }
});

test("a caller abort is distinct from the request deadline", async t => {
  const url = await endpoint(t, () => {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(testRequest(url, { signal: controller.signal }), error => error.details.category === "aborted");
});

test("subprocess deadlines terminate rather than waiting indefinitely", async () => {
  assert.throws(() => execTestFileSync(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }), /Integration subprocess failed/);
  const child = startTestNode(["-e", "setInterval(()=>{},1000)"], { timeoutMs: 150, label: "deadline-check" });
  const result = await child.done;
  assert.equal(result.timedOut, true);
  assert.ok(result.elapsedMs < 5_000);
});

test("normal subprocess completion detaches its abort listener", async () => {
  const controller = new AbortController();
  const managed = startTestNode(["-e", ""], { signal: controller.signal, label: "abort-cleanup", timeoutMs: 10_000 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const result = await managed.done;
  assert.equal(result.code, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("diagnostics redact credentials", () => {
  assert.equal(sanitizeDiagnostic(`agentrelay_${"f".repeat(64)} Authorization: Bearer gateway-value`), "[redacted-token] Authorization: Bearer [redacted]");
  assert.equal(sanitizeDiagnostic('{"MF-Proxy-Shared-Secret":"local-session-secret"}'), '{"MF-Proxy-Shared-Secret":"[redacted]"}');
  assert.equal(sanitizeDiagnostic("MF-Proxy-Shared-Secret: local-session-secret"), "MF-Proxy-Shared-Secret: [redacted]");
});

test("fixture errors retain stdout-only SQLite codes without exposing command arguments or output data", async () => {
  // Wrangler --json writes database errors to stdout; retaining stderr alone loses the reason for a failed fixture.
  const privateText = `agentrelay_${"e".repeat(64)} private-handoff-body`, sql = `UPDATE handoffs SET content = '${privateText}'`;
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify({ error: { text: `SQLITE_BUSY ${privateText}` } }))});process.exit(1)`;
  const verify = error => {
    assert.match(error.message, /SQLITE_BUSY/);
    assert.match(error.message, /stdoutBytes/);
    assert.ok(!error.message.includes(privateText) && !error.message.includes(sql));
    assert.equal(error.stderr, "");
    assert.equal(Object.hasOwn(error, "stdout"), false);
    return true;
  };
  assert.throws(() => execTestFileSync(process.execPath, ["-e", script, sql]), verify);
  await assert.rejects(execTestFile(process.execPath, ["-e", script, sql]), verify);
});

test("managed cleanup removes descendants as well as the parent", async () => {
  let descendant;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const managed = startTestNode(["-e", 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)'], {
    timeoutMs: 10_000, label: "owned-tree", onOutput: text => { if (/^\d+$/.test(text.trim())) { descendant = Number(text.trim()); ready(); } },
  });
  await Promise.race([started, managed.done.then(() => { throw new Error("Parent exited before reporting its descendant."); })]);
  managed.stop();
  const result = await managed.done;
  assert.equal(result.timedOut, false);
  assert.ok(descendant > 0);
  // The parent can close just before the operating system finishes terminating its child.
  const deadline = performance.now() + 2_000;
  let exited = false;
  do {
    try { process.kill(descendant, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      exited = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.ok(exited, "the descendant must terminate after its parent is stopped");
});

test("process completion includes the last output and redacts credentials split across chunks", async () => {
  let output = "";
  const managed = startTestNode(["-e", 'process.stdout.write("agentrelay_"+"a".repeat(32));setImmediate(()=>process.stdout.write("a".repeat(32)))'], {
    label: "split-output", timeoutMs: 10_000, onOutput: text => { output += text; },
  });
  assert.equal((await managed.done).code, 0);
  assert.equal(output, "[redacted-token]");
});
