// Runs the real purge, attachment and handoff services against the real migrations in SQLite, with the R2 double.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { FakeBucket, createD1, openDatabase } from "../support/d1-shim.mjs";
import { flat } from "../support/image-fixtures.mjs";
import { env, scheduled } from "../support/cloudflare-workers-stub.mjs";

const stubs = { "cloudflare:workers": path.join(projectRoot, "tests", "support", "cloudflare-workers-stub.mjs") };
const { uploadAttachment } = await loadTypeScriptModule("src/server/attachments/index.ts", { stubs, inProject: true });
const handoffsService = await loadTypeScriptModule("src/server/handoffs/index.ts", { stubs, inProject: true });
const { createHandoff, getHandoff, purgeExpiredHandoffs, sweepExpiredHandoffs } = handoffsService;

const owner = { owner: "owner-1", userId: "user-1", name: "Ann" }, other = { owner: "owner-2", userId: "user-2", name: "Bob" };
let db, bucket, workspaces = 0;
function fresh() { db = openDatabase(); env.DB = createD1(db); env.BUCKET = bucket = new FakeBucket(); }
const png = await flat({ format: "png", width: 10, height: 10 });
const key = () => crypto.randomUUID();
const put = async (actor = owner) => (await uploadAttachment(actor, { bytes: png, filename: "x.png", uploadKey: key(), declaredType: null })).attachment;
const draft = (extra = {}, actor = owner) => createHandoff(actor, { title: "T", content: "x", sourceDevice: "A", targetDevice: "B", requestKey: key(), ...extra });
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const count = (table, where = "1=1") => rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
const expire = (id, at) => db.prepare("UPDATE handoffs SET expires_at = ? WHERE id = ?").run(at, id);

test("only handoffs expired at the cutoff are deleted, with their images", async () => {
  fresh();
  const now = Date.now();
  const gone = await draft({ attachmentIds: [(await put()).id, (await put()).id] });
  const edge = await draft(), later = await draft({ attachmentIds: [(await put()).id] }), live = await draft();
  expire(gone.id, now - 1); expire(edge.id, now); expire(later.id, now + 1);
  assert.equal(await purgeExpiredHandoffs(owner.owner, { now }), 2);
  assert.deepEqual(rows("SELECT id FROM handoffs ORDER BY id").map(row => row.id), [later.id, live.id].sort());
  assert.equal(count("attachments"), 1, "the images of a handoff that is not expired yet stay");
  assert.equal(count("attachments", `handoff_id = '${later.id}'`), 1);
  assert.equal(count("object_cleanup"), 0);
  assert.equal(bucket.objects.size, 1);
  assert.ok(bucket.objects.has(`a/${later.attachments[0].id}`));
});

test("another workspace's expired handoffs and images are untouched", async () => {
  fresh();
  const mine = await draft(), theirs = await draft({ attachmentIds: [(await put(other)).id] }, other);
  expire(mine.id, 1); expire(theirs.id, 1);
  assert.equal(await purgeExpiredHandoffs(owner.owner), 1);
  assert.equal(count("handoffs", `id = '${theirs.id}'`), 1);
  assert.equal(count("attachments", `owner_id = '${other.owner}'`), 1);
  assert.equal(bucket.objects.size, 1);
});

test("the purge works in chunks of 50 and a second run is a no-op", async () => {
  fresh();
  for (let i = 0; i < 120; i++) await draft({ title: `H${i}` });
  db.exec("UPDATE handoffs SET expires_at = 1");
  assert.equal(await purgeExpiredHandoffs(owner.owner), 50);
  assert.equal(await purgeExpiredHandoffs(owner.owner, { chunks: 4 }), 70);
  assert.equal(count("handoffs"), 0);
  assert.equal(await purgeExpiredHandoffs(owner.owner, { chunks: 4 }), 0);
});

test("a chunk's images leave R2 in one call, and a failed call stays queued for the next purge", async () => {
  fresh();
  const first = await draft({ attachmentIds: [(await put()).id, (await put()).id] }), second = await draft({ attachmentIds: [(await put()).id] });
  expire(first.id, 1); expire(second.id, 1);
  bucket.failDeletes = true; bucket.deleteCalls = 0;
  assert.equal(await purgeExpiredHandoffs(owner.owner), 2, "the deletion commits even while R2 is down");
  assert.equal(bucket.deleteCalls, 1);
  assert.equal(count("attachments"), 0);
  assert.equal(count("object_cleanup", "attempts = 1"), 3);
  assert.equal(bucket.objects.size, 3);
  bucket.failDeletes = false;
  const late = await draft();
  expire(late.id, 1);
  await purgeExpiredHandoffs(owner.owner);
  assert.equal(count("object_cleanup"), 0);
  assert.equal(bucket.objects.size, 0);
});

test("a purge racing a reviewed deletion queues nothing twice", async () => {
  fresh();
  const created = await draft({ attachmentIds: [(await put()).id] });
  expire(created.id, 1);
  await handoffsService.deleteStorageHandoffs(owner.owner, { items: [{ id: created.id, version: created.version }] });
  bucket.failDeletes = true;
  assert.equal(await purgeExpiredHandoffs(owner.owner), 0);
  assert.equal(count("object_cleanup"), 0);
});

test("expired replies no longer use up a thread's room", async () => {
  fresh();
  const root = await draft();
  for (let i = 0; i < 99; i++) {
    const reply = await draft({ replyTo: root.id });
    if (i < 10) expire(reply.id, 1);
  }
  const room = await draft({ replyTo: root.id });
  assert.equal((await getHandoff(owner.owner, room.id)).thread.rootId, root.id);
});

test("the sweep runs after the response, at most once a minute per workspace, and never rejects", async () => {
  fresh();
  const workspace = `sweep-${++workspaces}`, actor = { ...owner, owner: workspace };
  const created = await draft({}, actor);
  expire(created.id, 1);
  let now = Date.now();
  const tasks = [], schedule = task => tasks.push(task);
  await sweepExpiredHandoffs(workspace, { now: () => now, schedule });
  assert.equal(tasks.length, 1);
  assert.equal(count("handoffs"), 0);
  const next = await draft({}, actor);
  expire(next.id, 1);
  await sweepExpiredHandoffs(workspace, { now: () => now + 30_000, schedule });
  assert.equal(tasks.length, 1, "a second request within the minute does not sweep");
  assert.equal(count("handoffs"), 1);
  now += 60_000;
  env.DB = { prepare() { throw new Error("D1 unavailable"); } };
  const warn = console.warn; console.warn = () => {};
  try { await sweepExpiredHandoffs(workspace, { now: () => now, schedule }); } finally { console.warn = warn; }
  assert.equal(tasks.length, 2, "a failing sweep resolves instead of failing the request");
});

test("without a test schedule the sweep is handed to waitUntil", async () => {
  fresh();
  const workspace = `sweep-${++workspaces}`, before = scheduled.length;
  await sweepExpiredHandoffs(workspace);
  assert.equal(scheduled.length, before + 1);
});
