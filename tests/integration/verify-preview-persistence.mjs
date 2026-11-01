import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { runTestNode, sanitizeRunLogs } from "../support/integration-process.mjs";
import { flat } from "../support/image-fixtures.mjs";
import { localTestEnvironment, startLocalPreview } from "../support/local-preview.mjs";

const directory = path.join(projectRoot, "outputs/verification", `preview-persistence-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
const env = localTestEnvironment(directory);
const owner = `persistence-qa-${randomUUID()}`;
const identity = { "oai-authenticated-user-id": owner, Connection: "close" };
const content = "Synthetic persistence check\r\n中文 🚀\n";
const image = await flat({ format: "png", width: 12, height: 9 });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { completed: false, checks: [], imageSha256: digest(image) };
let preview;

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
}

try {
  const migration = await runTestNode(["scripts/db/migrate-local.mjs", "--state-dir", env.AGENTRELAY_TEST_STATE], {
    env, label: "persistence-migrations", logFile: path.join(directory, "migrations.log"), timeoutMs: 240_000,
  });
  assert.equal(migration.code, 0, "the disposable local database must migrate");
  preview = await startLocalPreview(env, { label: "before-restart" });
  const upload = await request(`${preview.url}/api/attachments`, {
    method: "POST", headers: { ...identity, "X-Upload-Key": randomUUID(), "X-Filename": "synthetic.png", "Content-Type": "image/png" }, body: image,
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const attachment = await upload.json();
  const created = await request(`${preview.url}/api/handoffs`, {
    method: "POST", headers: { ...identity, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Persistence", content, sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: randomUUID(), attachmentIds: [attachment.id] }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const handoff = await created.json();
  preview.stop();
  await preview.done;
  preview = undefined;

  // A new preview process must reopen the same local D1 and R2 state, not a fresh store.
  preview = await startLocalPreview(env, { label: "after-restart" });
  const read = await request(`${preview.url}/api/handoffs/${handoff.id}`, { headers: identity });
  assert.equal(read.status, 200);
  const stored = await read.json();
  assert.equal(stored.content, content);
  assert.deepEqual(stored.attachments.map(item => item.id), [attachment.id]);
  report.checks.push("D1 retained the handoff and attachment manifest");
  const downloaded = await request(`${preview.url}/api/handoffs/${handoff.id}/attachments/${attachment.id}`, { headers: identity });
  assert.equal(downloaded.status, 200);
  assert.equal(digest(new Uint8Array(await downloaded.arrayBuffer())), digest(image));
  report.checks.push("R2 retained the original image bytes");
  report.completed = true;
  console.log(JSON.stringify(report));
} finally {
  if (preview) { preview.stop(); await preview.done; }
  sanitizeRunLogs(directory);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2));
  console.log(`Preview persistence evidence: ${directory}`);
}
