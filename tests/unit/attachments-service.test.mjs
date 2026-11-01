// Runs the real attachment and handoff services against the real migrations in SQLite, with a failure-injecting R2 double.
// It covers what a live Worker cannot stage deterministically: interleavings, rollbacks and storage outages.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { FakeBucket, createD1, openDatabase } from "../support/d1-shim.mjs";
import { flat, fromPixels } from "../support/image-fixtures.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";

const stubs = { "cloudflare:workers": path.join(projectRoot, "tests", "support", "cloudflare-workers-stub.mjs") };
const attachmentsService = await loadTypeScriptModule("src/server/attachments/index.ts", { stubs, inProject: true });
const handoffsService = await loadTypeScriptModule("src/server/handoffs/index.ts", { stubs, inProject: true });
const { uploadAttachment, sweepAttachments, cleanupSummary, readAttachment, attachmentManifests, resolveBindable } = attachmentsService;
const { createHandoff, getHandoff, deleteStorageHandoffs, listHandoffs } = handoffsService;

const HOUR = 3_600_000;
const owner = { owner: "owner-1", userId: "user-1", name: "Ann" }, other = { owner: "owner-2", userId: "user-2", name: "Bob" };
let db, bucket, hooks;
function fresh() {
  db = openDatabase(); hooks = {};
  env.DB = createD1(db, hooks); env.BUCKET = bucket = new FakeBucket();
}
const png = await flat({ format: "png", width: 10, height: 10 });
const jpeg = await flat({ format: "jpeg", width: 10, height: 10 });
const key = () => crypto.randomUUID();
const put = async (bytes = png, actor = owner, uploadKey = key()) => (await uploadAttachment(actor, { bytes, filename: "x.png", uploadKey, declaredType: null })).attachment;
const draft = (extra = {}, actor = owner) => createHandoff(actor, { title: "T", sourceDevice: "A", targetDevice: "B", requestKey: key(), ...extra });
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const count = (table, where = "1=1") => rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);
const age = (id, hours) => db.exec(`UPDATE attachments SET created_at = ${Date.now() - hours * HOUR} WHERE id = '${id}'`);

test("an upload writes the object under a private key and is idempotent per key", async () => {
  fresh();
  const uploadKey = key();
  const first = await uploadAttachment(owner, { bytes: png, filename: "a.png", uploadKey, declaredType: "image/png" });
  assert.equal(first.created, true);
  assert.equal(first.attachment.sha256.length, 64);
  const row = rows("SELECT * FROM attachments")[0];
  assert.equal(row.state, "ready");
  assert.equal(row.object_key, `a/${row.id}`);
  assert.deepEqual([...bucket.objects.get(row.object_key)], [...png]);
  const replay = await uploadAttachment(owner, { bytes: png, filename: "a.png", uploadKey, declaredType: null });
  assert.equal(replay.created, false);
  assert.equal(replay.attachment.id, first.attachment.id);
  assert.equal(count("attachments"), 1);
  await rejects(uploadAttachment(owner, { bytes: jpeg, filename: "a.jpg", uploadKey, declaredType: null }), 409);
  assert.ok(!("objectKey" in first.attachment) && !("ownerId" in first.attachment) && !("uploadKey" in first.attachment));
});

test("an interrupted upload leaves a pending row that a retry completes, never a stray object", async () => {
  fresh();
  const uploadKey = key();
  bucket.failPuts = true;
  await assert.rejects(uploadAttachment(owner, { bytes: png, filename: "a.png", uploadKey, declaredType: null }));
  assert.equal(rows("SELECT state FROM attachments")[0].state, "pending");
  assert.equal(bucket.objects.size, 0);
  const pendingId = rows("SELECT id FROM attachments")[0].id;
  await rejects(draft({ content: "x", attachmentIds: [pendingId] }), 409);
  bucket.failPuts = false;
  const retried = await uploadAttachment(owner, { bytes: png, filename: "a.png", uploadKey, declaredType: null });
  assert.equal(retried.attachment.id, pendingId);
  assert.equal(rows("SELECT state FROM attachments")[0].state, "ready");
  assert.equal(bucket.objects.size, 1);
});

test("a pending upload that is never retried is reclaimed together with its possible object", async () => {
  fresh();
  bucket.failPuts = true;
  await assert.rejects(uploadAttachment(owner, { bytes: png, filename: "a.png", uploadKey: key(), declaredType: null }));
  bucket.failPuts = false;
  db.exec(`UPDATE attachments SET created_at = ${Date.now() - 25 * HOUR}`);
  const result = await sweepAttachments(owner.owner);
  assert.equal(result.reclaimedUploads, 1);
  assert.equal(count("attachments"), 0);
  assert.equal(count("object_cleanup"), 0);
});

test("text, images and order are stored together and the guard leaves no residue", async () => {
  fresh();
  const [a, b, c] = [await put(png), await put(jpeg), await put(png)];
  const created = await draft({ content: "  exact\r\n text  ", attachmentIds: [c.id, a.id, b.id] });
  assert.equal(created.content, "  exact\r\n text  ");
  assert.deepEqual(created.attachments.map(item => item.id), [c.id, a.id, b.id]);
  assert.deepEqual(created.attachments.map(item => item.position), [0, 1, 2]);
  const stored = rows("SELECT attachment_count AS c, attachment_bytes AS b FROM handoffs")[0];
  assert.equal(stored.c, 3);
  assert.equal(stored.b, png.length * 2 + jpeg.length);
  assert.equal(count("attachment_bind_guard"), 0);
  assert.ok(!("attachmentCount" in created) && !("attachmentBytes" in created));
  assert.deepEqual((await getHandoff(owner.owner, created.id)).attachments.map(item => item.id), [c.id, a.id, b.id]);
});

test("content may be empty only when an image is attached", async () => {
  fresh();
  const a = await put();
  assert.equal((await draft({ attachmentIds: [a.id] })).content, "");
  await rejects(draft({ content: "" }), 400);
  await rejects(draft({}), 400);
  await rejects(draft({ content: 5, attachmentIds: [(await put(png, owner)).id] }), 400);
  await rejects(draft({ content: "x".repeat(200_001), attachmentIds: [(await put(png, owner)).id] }), 400);
});

test("an upload claimed after the check rolls the whole creation back", async () => {
  fresh();
  const [a, b] = [await put(), await put(jpeg)];
  hooks.beforeBatch = sqls => { if (sqls.some(sql => sql.includes("attachment_bind_guard"))) db.exec(`UPDATE attachments SET handoff_id = 'thief', position = 0 WHERE id = '${b.id}'`); };
  await rejects(draft({ content: "x", attachmentIds: [a.id, b.id] }), 409);
  hooks.beforeBatch = undefined;
  assert.equal(count("handoffs"), 0);
  assert.equal(rows("SELECT handoff_id FROM attachments WHERE id = ?", a.id)[0].handoff_id, null, "the first image must not stay attached");
  assert.equal(count("attachment_bind_guard"), 0);
});

test("an upload reclaimed after the check also rolls the creation back, and cleanup never reclaims a bound upload", async () => {
  fresh();
  const a = await put();
  // The sweep wins the race in the middle of the creation: it sees an unattached, stale row and removes it first.
  const sweepFirst = { run: false };
  hooks.beforeBatch = sqls => {
    if (!sweepFirst.run && sqls.some(sql => sql.includes("attachment_bind_guard"))) { sweepFirst.run = true; age(a.id, 25); hooks.sweepNow(); }
  };
  hooks.sweepNow = () => {
    const stale = Date.now() - 24 * HOUR;
    db.exec(`INSERT INTO object_cleanup (id, owner_id, object_key, byte_size, attempts, created_at) SELECT 'q', owner_id, object_key, byte_size, 0, 1 FROM attachments WHERE id = '${a.id}' AND handoff_id IS NULL AND created_at < ${stale}`);
    db.exec(`DELETE FROM attachments WHERE id = '${a.id}' AND handoff_id IS NULL AND created_at < ${stale}`);
  };
  await rejects(draft({ content: "x", attachmentIds: [a.id] }), 404);
  assert.equal(count("handoffs"), 0);
  hooks.beforeBatch = undefined;

  const b = await put();
  const created = await draft({ content: "bound", attachmentIds: [b.id] });
  age(b.id, 48);
  const swept = await sweepAttachments(owner.owner);
  assert.equal(swept.reclaimedUploads, 0, "an upload that a handoff owns is never reclaimed, however old");
  assert.equal(rows("SELECT handoff_id FROM attachments WHERE id = ?", b.id)[0].handoff_id, created.id);
  assert.ok(bucket.objects.has(`a/${b.id}`));
});

test("foreign, bound, expired and missing uploads are refused and nothing partial is created", async () => {
  fresh();
  const mine = await put(), theirs = await put(png, other), bound = await put(), stale = await put();
  await draft({ content: "x", attachmentIds: [bound.id] });
  age(stale.id, 30);
  const before = count("handoffs");
  const answers = [];
  for (const [id, status] of [[theirs.id, 404], ["missing", 404], [bound.id, 409], [stale.id, 409]]) {
    await assert.rejects(draft({ content: "x", attachmentIds: [mine.id, id] }), error => { answers.push(error.message); return error.status === status; });
  }
  assert.equal(answers[0], answers[1], "foreign and missing ids must answer identically");
  assert.equal(count("handoffs"), before);
  assert.equal(rows("SELECT handoff_id FROM attachments WHERE id = ?", mine.id)[0].handoff_id, null);
  await assert.rejects(resolveBindable(other.owner, [mine.id]), error => error.status === 404);
});

test("a retried creation returns the original and never re-binds; a changed retry conflicts", async () => {
  fresh();
  const [a, b] = [await put(), await put(jpeg)];
  const requestKey = key(), body = { content: "retry", attachmentIds: [a.id, b.id], requestKey };
  const first = await draft(body), second = await draft(body);
  assert.equal(second.id, first.id);
  assert.equal(count("handoffs"), 1);
  await rejects(draft({ ...body, attachmentIds: [b.id, a.id] }), 409);
  await rejects(draft({ ...body, attachmentIds: [a.id] }), 409);
  await rejects(draft({ ...body, content: "other" }), 409);
  const plainKey = key();
  const plain = await draft({ content: "same", requestKey: plainKey });
  assert.equal((await draft({ content: "same", requestKey: plainKey })).id, plain.id);
  await rejects(draft({ content: "same", requestKey: plainKey, attachmentIds: [(await put()).id] }), 409);
});

test("a stale deletion removes nothing; a current one queues the objects and clears them", async () => {
  fresh();
  const created = await draft({ content: "x", attachmentIds: [(await put()).id, (await put(jpeg)).id] });
  const stale = await deleteStorageHandoffs(owner.owner, { items: [{ id: created.id, version: created.version + 1 }] });
  assert.equal(stale.results[0].status, "conflict");
  assert.equal(count("attachments", `handoff_id = '${created.id}'`), 2);
  assert.equal(count("object_cleanup"), 0);
  assert.equal(bucket.objects.size, 2);
  const done = await deleteStorageHandoffs(owner.owner, { items: [{ id: created.id, version: created.version }] });
  assert.equal(done.results[0].status, "deleted");
  assert.equal(count("attachments"), 0);
  assert.equal(count("object_cleanup"), 0);
  assert.equal(bucket.objects.size, 0);
  assert.equal(count("handoffs"), 0);
});

test("when R2 is down the deletion still commits and the pending cleanup stays visible and retryable", async () => {
  fresh();
  const created = await draft({ content: "x", attachmentIds: [(await put()).id, (await put(jpeg)).id] });
  bucket.failDeletes = true;
  const done = await deleteStorageHandoffs(owner.owner, { items: [{ id: created.id, version: created.version }] });
  assert.equal(done.results[0].status, "deleted");
  assert.equal(count("attachments"), 0);
  const queued = rows("SELECT attempts, last_error AS lastError, byte_size AS bytes FROM object_cleanup");
  assert.equal(queued.length, 2);
  assert.ok(queued.every(item => item.attempts === 1 && item.lastError === "R2 delete failed"));
  assert.equal(bucket.objects.size, 2);
  const summary = await cleanupSummary(owner.owner);
  assert.deepEqual(summary.pendingCleanup, { count: 2, bytes: png.length + jpeg.length, failing: 2 });
  const again = await sweepAttachments(owner.owner);
  assert.equal(again.deletedObjects, 0);
  assert.equal(count("object_cleanup", "attempts = 2"), 2);
  bucket.failDeletes = false;
  const recovered = await sweepAttachments(owner.owner);
  assert.equal(recovered.deletedObjects, 2);
  assert.equal(recovered.pendingCleanup.count, 0);
  assert.equal(bucket.objects.size, 0);
});

test("queued objects are deleted with one R2 call per batch", async () => {
  fresh();
  const created = await draft({ content: "x", attachmentIds: [(await put()).id, (await put(jpeg)).id, (await put(png)).id] });
  bucket.deleteCalls = 0;
  await deleteStorageHandoffs(owner.owner, { items: [{ id: created.id, version: created.version }] });
  assert.equal(bucket.deleteCalls, 1);
  assert.equal(count("object_cleanup"), 0);
  assert.equal(bucket.objects.size, 0);
});

test("rows left behind by code that predates cleanup are reclaimed, and cleanup is owner-scoped", async () => {
  fresh();
  const dangling = await put(), mineOld = await put(), theirsOld = await put(png, other);
  db.exec(`UPDATE attachments SET handoff_id = 'gone', position = 0 WHERE id = '${dangling.id}'`);
  age(mineOld.id, 30); age(theirsOld.id, 30);
  const result = await sweepAttachments(owner.owner);
  assert.equal(result.reclaimedUploads, 2);
  assert.equal(count("attachments", `id = '${theirsOld.id}'`), 1, "another owner's stale upload is untouched by this owner's cleanup");
  assert.equal(bucket.objects.has(`a/${theirsOld.id}`), true);
});

test("reads honour handoff expiry, ownership and the handoff the image belongs to", async () => {
  fresh();
  const created = await draft({ content: "x", attachmentIds: [(await put()).id] }), id = created.attachments[0].id;
  const read = await readAttachment(owner.owner, created.id, id);
  assert.equal(read.info.id, id);
  await assert.rejects(readAttachment(other.owner, created.id, id), error => error.status === 404);
  await assert.rejects(readAttachment(owner.owner, "other-handoff", id), error => error.status === 404);
  db.exec(`UPDATE handoffs SET expires_at = 1 WHERE id = '${created.id}'`);
  await assert.rejects(readAttachment(owner.owner, created.id, id), error => error.status === 404);
  assert.equal((await readAttachment(owner.owner, created.id, id, { includeExpired: true })).info.id, id);
  bucket.objects.clear();
  await assert.rejects(readAttachment(owner.owner, created.id, id, { includeExpired: true }), error => error.status === 404);
});

test("manifests for hundreds of handoffs are loaded in bounded queries", async () => {
  fresh();
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const image = await fromPixels({ format: "png", width: 4, height: 4, pixel: () => [i, i, i] });
    ids.push((await draft({ content: `h${i}`, attachmentIds: [(await put(image)).id] })).id);
  }
  const queries = [];
  const batch = env.DB.batch;
  env.DB.batch = async statements => { queries.push(...statements.map(statement => statement.params.length)); return batch(statements); };
  const manifests = await attachmentManifests(owner.owner, ids);
  assert.equal(manifests.size, 120);
  assert.ok(queries.every(parameters => parameters <= 91), "each statement stays under D1's 100 bound-parameter limit");
  assert.equal((await listHandoffs(owner.owner)).filter(row => row.attachments.length === 1).length, 120);
});
