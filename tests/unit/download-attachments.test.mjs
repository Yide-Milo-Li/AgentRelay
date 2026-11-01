import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DownloadError, defaultOutputDir, downloadImages, localFileName, readManifest } from "../../tooling/agents/download-attachments.mjs";
import { flat } from "../support/image-fixtures.mjs";

const TOKEN = `agentrelay_${"a".repeat(64)}`;
const GATEWAY = "Bearer secret-gateway";
const SITE = "https://agentrelay.example.chatgpt.site";
const HANDOFF = "6087ef28-5c86-491e-a549-6ad2d714b087";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for the Site: one handoff with the given images, served the way the real routes answer. */
async function fakeSite(images) {
  const stored = new Map(), manifest = [];
  images.forEach(({ filename, bytes, mimeType = "image/png" }, index) => {
    const id = `att-${index}`;
    stored.set(id, bytes);
    manifest.push({ id, filename, mimeType, bytes: bytes.length, width: 3, height: 3, sha256: sha(bytes), position: index });
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === `${SITE}/api/agent/mcp`) {
      const text = JSON.stringify({ id: HANDOFF, content: "", attachments: manifest });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }), { status: 200 });
    }
    const id = decodeURIComponent(url.split("/").pop());
    return stored.has(id) ? new Response(stored.get(id), { status: 200 }) : new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls, manifest, stored };
}
const run = (fetchImpl, outDir, handoffId = HANDOFF) => downloadImages({ handoffId, siteUrl: SITE, agentToken: TOKEN, authorization: GATEWAY, outDir, fetchImpl });
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-dl-test-"));

test("images are written in manifest order with verified bytes", async () => {
  const [a, b] = [await flat({ format: "png", width: 3, height: 3 }), await flat({ format: "webp", width: 4, height: 4 })];
  const site = await fakeSite([{ filename: "first.png", bytes: a }, { filename: "second.webp", bytes: b, mimeType: "image/webp" }]);
  const dir = tempDir();
  try {
    const result = await run(site.fetchImpl, dir);
    assert.deepEqual(result.files.map(file => path.basename(file.path)), ["01-first.png", "02-second.webp"]);
    assert.deepEqual(result.files.map(file => file.position), [1, 2]);
    assert.equal(sha(fs.readFileSync(result.files[0].path)), sha(a));
    assert.equal(sha(fs.readFileSync(result.files[1].path)), sha(b));
    const download = site.calls.find(call => call.url.includes("/attachments/att-0"));
    assert.equal(download.url, `${SITE}/api/agent/handoffs/${HANDOFF}/attachments/att-0`);
    assert.equal(download.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(download.init.headers["OAI-Sites-Authorization"], GATEWAY);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a rerun keeps correct files and downloads nothing", async () => {
  const bytes = await flat({ format: "png", width: 3, height: 3 });
  const site = await fakeSite([{ filename: "x.png", bytes }]);
  const dir = tempDir();
  try {
    await run(site.fetchImpl, dir);
    const before = site.calls.length;
    const again = await run(site.fetchImpl, dir);
    assert.equal(site.calls.length - before, 1, "only the manifest is read again");
    assert.equal(again.files.length, 1);
    fs.writeFileSync(again.files[0].path, "tampered");
    await run(site.fetchImpl, dir);
    assert.equal(sha(fs.readFileSync(again.files[0].path)), sha(bytes), "a damaged file is replaced");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a hash or length mismatch is rejected and leaves no file behind", async () => {
  const bytes = await flat({ format: "png", width: 3, height: 3 });
  for (const corrupt of [new Uint8Array(bytes.length).fill(7), bytes.slice(0, bytes.length - 1)]) {
    const site = await fakeSite([{ filename: "x.png", bytes }]);
    site.stored.set("att-0", corrupt);
    const dir = tempDir();
    try {
      await assert.rejects(run(site.fetchImpl, dir), error => error instanceof DownloadError && /received|integrity/.test(error.message));
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("hostile filenames stay inside the output folder", async () => {
  const bytes = await flat({ format: "png", width: 3, height: 3 });
  const names = ["../../evil.png", "..\\..\\evil.png", "C:\\Windows\\system32\\x.png", "/etc/passwd", "con.png", "a\u0000b\nc.png", "日本語.png", "x".repeat(500) + ".png", "", ".png"];
  const site = await fakeSite(names.map(filename => ({ filename, bytes })));
  const dir = tempDir();
  try {
    const result = await run(site.fetchImpl, dir);
    const real = fs.realpathSync(dir);
    assert.equal(result.files.length, names.length);
    for (const file of result.files) {
      assert.equal(path.dirname(fs.realpathSync(file.path)), real);
      assert.match(path.basename(file.path), /^\d\d-[A-Za-z0-9_-]{1,80}\.png$/);
    }
    assert.equal(fs.readdirSync(dir).length, names.length);
    assert.equal(fs.existsSync(path.join(dir, "..", "evil.png")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("local names follow the verified image type, not the stored extension", () => {
  assert.equal(localFileName(1, "photo.exe", "image/jpeg"), "01-photo.jpg");
  assert.equal(localFileName(10, "a b.PNG", "image/png"), "10-a_b.png");
  assert.throws(() => localFileName(1, "x.gif", "image/gif"), DownloadError);
});

test("handoff ids that could escape the temp folder are refused before any request", async () => {
  let called = 0;
  for (const id of ["../x", "a/b", "a\\b", "", "x".repeat(200)]) await assert.rejects(run(async () => { called++; }, undefined, id), DownloadError);
  assert.equal(called, 0);
  assert.equal(defaultOutputDir(HANDOFF, "/base").replaceAll("\\", "/"), `/base/agentrelay/${HANDOFF}`);
});

test("refusals are reported without echoing a credential", async () => {
  const dir = tempDir();
  try {
    for (const [status, pattern] of [[401, /refused the credentials \(401\)/], [403, /refused the credentials \(403\)/], [404, /not found/]]) {
      const error = await run(async () => new Response("{}", { status }), dir).catch(e => e);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(TOKEN) || error.message.includes("secret-gateway"), false);
    }
    await assert.rejects(run(async () => new Response("<html>login</html>", { status: 200 }), dir), /without handoff data/);
    await assert.rejects(run(async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); }, dir), /cannot reach the AgentRelay site \(ECONNREFUSED\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a download refusal midway names the file and keeps earlier ones", async () => {
  const bytes = await flat({ format: "png", width: 3, height: 3 });
  const site = await fakeSite([{ filename: "a.png", bytes }, { filename: "b.png", bytes: await flat({ format: "png", width: 4, height: 4 }) }]);
  site.stored.delete("att-1");
  const dir = tempDir();
  try {
    await assert.rejects(run(site.fetchImpl, dir), /02-b\.png: not found/);
    assert.deepEqual(fs.readdirSync(dir), ["01-a.png"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a manifest without images or with malformed entries is rejected", async () => {
  const wrap = attachments => async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ attachments }) }] } }), { status: 200 });
  const ask = fetchImpl => readManifest({ handoffId: HANDOFF, siteUrl: SITE, agentToken: TOKEN, authorization: GATEWAY, fetchImpl });
  await assert.rejects(ask(wrap([])), /no images/);
  await assert.rejects(ask(wrap([{ id: "a/b", sha256: "0".repeat(64), bytes: 5, position: 0 }])), /malformed/);
  await assert.rejects(ask(wrap([{ id: "a", sha256: "xyz", bytes: 5, position: 0 }])), /malformed/);
  await assert.rejects(ask(wrap([{ id: "a", sha256: "0".repeat(64), bytes: 2_000_000, position: 0 }])), /malformed/);
  const errorResult = async () => new Response(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "Handoff not found." }] } }), { status: 200 });
  await assert.rejects(ask(errorResult), /Handoff not found/);
});
