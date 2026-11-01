import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { previewFetch } from "../../tooling/environment/preview-request-drain.mjs";
import { prepareLocalPreview } from "../../tooling/environment/prepare-local-preview.mjs";
import { localTestEnvironment } from "../support/local-preview.mjs";

test("disposable previews use short isolated state paths and preserve explicitly shared state", t => {
  const output = path.join(projectRoot, "outputs");
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, "preview-state-test-"));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(output) + path.sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const first = localTestEnvironment(path.join(directory, "first"));
  const repeated = localTestEnvironment(path.join(directory, "first"));
  const other = localTestEnvironment(path.join(directory, "other"));
  const shared = localTestEnvironment(path.join(directory, "shared"), first.AGENTRELAY_TEST_STATE);
  assert.ok(first.AGENTRELAY_TEST_STATE.startsWith(path.join(projectRoot, ".sites-runtime", "test-state") + path.sep));
  assert.ok(first.TEMP.startsWith(path.join(projectRoot, ".sites-runtime", "test-tmp") + path.sep));
  assert.equal(first.TEMP, first.TMP);
  assert.notEqual(first.TEMP, other.TEMP);
  assert.equal(first.AGENTRELAY_TEST_STATE, repeated.AGENTRELAY_TEST_STATE);
  assert.notEqual(first.AGENTRELAY_TEST_STATE, other.AGENTRELAY_TEST_STATE);
  assert.equal(first.AGENTRELAY_TEST_STATE, shared.AGENTRELAY_TEST_STATE);
});

test("local draining consumes a body transferred by a framework while preserving its early response", async () => {
  const request = new Request("http://local.test", { method: "POST", body: "unread payload" });
  let transferred;
  const response = await previewFetch({ fetch(incoming) {
    transferred = new Request(incoming);
    return new Response("denied", { status: 401, headers: { "X-Rejection": "original" } });
  } }, request);
  assert.equal(request.bodyUsed, true);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("X-Rejection"), "original");
  assert.equal(await response.text(), "denied");
  await transferred.body.cancel();
});

test("an ordinary upload reaches the application byte for byte through Request transfer", async () => {
  const content = "\r\n exact 中文 🚀\n";
  const response = await previewFetch({ async fetch(incoming) {
    return new Response(await new Request(incoming).arrayBuffer(), { status: 201 });
  } }, new Request("http://local.test", { method: "POST", body: content }));
  assert.equal(response.status, 201);
  assert.equal(await response.text(), content);
});

test("the preview drain bounds bytes from an unending upload", async () => {
  let pulls = 0, forwarded;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8)); } });
  const response = await previewFetch({ fetch(request) { forwarded = request; return new Response(null, { status: 413 }); } },
    new Request("http://local.test", { method: "POST", body: stream, duplex: "half" }), undefined, undefined, { maxBytes: 16 });
  assert.equal(response.status, 413);
  assert.ok(pulls < 16, "a refusal must not drain an unlimited source");
  await forwarded.body.cancel();
});

test("an idle upload cannot delay an early refusal or replace an application exception indefinitely", async () => {
  for (const throws of [false, true]) {
    let forwarded;
    const failure = new Error("application failure"), started = performance.now();
    const task = previewFetch({ fetch(request) { forwarded = request; if (throws) throw failure; return new Response(null, { status: 401 }); } },
      new Request("http://local.test", { method: "POST", body: new ReadableStream(), duplex: "half" }), undefined, undefined, { timeoutMs: 30 });
    if (throws) await assert.rejects(task, error => error === failure);
    else assert.equal((await task).status, 401);
    assert.ok(performance.now() - started < 2_000);
    await forwarded.body.cancel();
  }
});

test("preview configuration rebases assets and migrations without modifying the deployable configuration", t => {
  const output = path.join(projectRoot, "outputs");
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, "preview-config-test-"));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(output) + path.sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = path.join(directory, "dist/server"), target = path.join(directory, "runtime");
  mkdirSync(base, { recursive: true });
  const original = { main: "index.js", name: "synthetic-preview", no_bundle: true, compatibility_date: "2026-05-15",
    assets: { directory: "../client" }, build: { watch_dir: ["./src"] },
    d1_databases: [{ binding: "DB", database_id: "synthetic-id", migrations_dir: "../../drizzle" }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "synthetic-bucket" }] };
  const file = path.join(base, "wrangler.json"), source = JSON.stringify(original);
  writeFileSync(file, source);
  const prepared = JSON.parse(readFileSync(prepareLocalPreview(file, target), "utf8"));
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(prepared.assets.directory, path.resolve(base, "../client"));
  assert.equal(prepared.d1_databases[0].migrations_dir, path.resolve(base, "../../drizzle"));
  assert.equal(prepared.d1_databases[0].database_id, original.d1_databases[0].database_id);
  assert.deepEqual(prepared.r2_buckets, original.r2_buckets);
  assert.equal(prepared.compatibility_date, original.compatibility_date);
  assert.equal(prepared.no_bundle, false);
  assert.equal(prepared.main, path.join(target, "entry.mjs"));
});
