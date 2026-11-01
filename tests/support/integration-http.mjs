import path from "node:path";
import { assertSupportedNodeRuntime } from "../../tooling/environment/node-runtime.mjs";

assertSupportedNodeRuntime();

function safeRoute(url) {
  return new URL(url).pathname.replace(/\/(handoffs|attachments|agent-tokens|devices|projects)\/([^/]+)/g,
    (_, resource, id) => `/${resource}/${["delete", "cleanup"].includes(id) ? id : ":id"}`);
}

/** One attempt only: an interrupted write may already have committed on the Worker. */
export async function testRequest(url, options = {}, settings = {}) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("Integration requests require a local Worker.");
  const method = options.method ?? "GET";
  const timeoutMs = settings.timeoutMs ?? (["GET", "HEAD"].includes(method) ? 15_000 : 60_000);
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response, category = "transport";
  try {
    response = await fetch(url, { redirect: "manual", ...options, signal });
    // Keep the same deadline until the body has arrived, not just until headers arrive.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const text = new TextDecoder().decode(bytes);
    if (response.status >= 500) {
      category = response.status === 503 && text.includes("worker restarted mid-request") ? "proxy-restart" : "http-server";
      throw new Error(category);
    }
    let data = null;
    const format = settings.format ?? "json";
    if (bytes.length && (format === "json" || (format === "auto" && contentType.includes("json")))) {
      category = "invalid-json";
      data = JSON.parse(text);
    }
    return { status: response.status, headers: response.headers, bytes, text, data, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    const details = {
      suite: settings.suite ?? path.basename(process.argv[1] ?? "integration"),
      check: settings.label ?? `${method} ${safeRoute(url)}`, method, route: safeRoute(url), attempt: 1,
      elapsedMs: Math.round(performance.now() - started), timeoutMs,
      category: deadline.aborted ? "timeout" : signal.aborted ? "aborted" : category,
      status: response?.status ?? null, contentType: response?.headers.get("content-type") ?? null,
      code: error.cause?.code ?? null,
    };
    // Never include headers, bodies, query parameters, or the underlying fetch error's URL.
    const failure = new Error(`Integration request failed: ${JSON.stringify(details)}`);
    failure.details = details;
    throw failure;
  }
}
