// Built-Worker checks for notifications that follow the handoff lifecycle, through every entry point that changes a handoff.
// The seeded subscription points at an address the sender refuses before any request is made, so no push leaves this machine.
// A delivery is therefore recorded as a "configuration" failure, which is exactly the proof that the work ran after the response.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execTestFileSync as execFileSync } from "../support/integration-process.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Notification event checks require a local built Worker URL.");
const run = crypto.randomUUID(), owner = `notify-qa-${run}`, stranger = `notify-other-${run}`, browserId = crypto.randomUUID(), passed = [];
// Expiry reminders get a workspace of their own, so its first sweep is not held back by the sweeps above.
const reminderOwner = `notify-expiry-${run}`, reminderBrowser = crypto.randomUUID();
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
const identity = user => ({ ...identityHeaders(user, "test@sites.test") });
const request = (path, method = "GET", data, headers = identity(owner)) => testRequest(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
const sql = command => execFileSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", process.env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json",
  "--persist-to", process.env.AGENTRELAY_TEST_STATE ?? ".wrangler/state", "--command", command], { stdio: "pipe" }).toString();
const rpc = (path, name, args, headers) => request(path, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
const created = response => { assert.equal(response.status, 200); assert.ok(!response.data.result.isError, response.data.result.content?.[0]?.text); return JSON.parse(response.data.result.content[0].text); };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

const attempt = async (id = browserId, headers = identity(owner)) => (await request(`/api/notifications?browserId=${id}`, "GET", undefined, headers)).data.subscription;
/** Wait until a new delivery attempt is recorded after `since`; the sender refuses the address, so the error is always "configuration". */
async function nextAttempt(since, label, ...who) {
  for (let turn = 0; turn < 80; turn++) {
    const row = await attempt(...who);
    if (row.lastAttemptAt > since) { assert.equal(row.lastError, "configuration", label); passed.push(label); return row.lastAttemptAt; }
    await delay(125);
  }
  assert.fail(`${label}: no delivery was attempted`);
}
async function stays(since, label, ...who) { await delay(1500); assert.equal((await attempt(...who)).lastAttemptAt, since, label); passed.push(label); }
const handoff = (extra = {}) => ({ title: "Notification event check", content: "Synthetic prompt", sourceDevice: "desktop", targetDevice: "laptop", requestKey: crypto.randomUUID(), ...extra });

try {
  check("a device is registered for the check", (await request("/api/devices", "POST", { name: "Laptop", id: "laptop" })).status === 201);
  const now = Date.now();
  sql(`INSERT INTO notification_subscriptions (owner_id, browser_id, device_id, endpoint, endpoint_hash, p256dh, auth, locale, created_at, updated_at, version) VALUES (${quote(owner)}, ${quote(browserId)}, 'laptop', 'https://push.invalid/never-contacted', 'synthetic', 'synthetic', 'synthetic', 'en', ${now}, ${now}, 1);`);
  let last = (await attempt()).lastAttemptAt ?? 0;
  check("the seeded subscription is visible to its owner only", last === 0 && (await request(`/api/notifications?browserId=${browserId}`, "GET", undefined, identity(stranger))).data.subscription === null);

  const first = (await request("/api/handoffs", "POST", handoff()));
  check("creating over HTTP succeeds", first.status === 201);
  last = await nextAttempt(last, "HTTP create");
  const key = crypto.randomUUID(), body = handoff({ requestKey: key });
  const withKey = await request("/api/handoffs", "POST", body);
  last = await nextAttempt(last, "HTTP create with a request key");
  const replay = await request("/api/handoffs", "POST", body);
  check("a replayed request returns the same handoff", replay.status === 201 && replay.data.id === withKey.data.id);
  await stays(last, "an HTTP replay stays quiet");

  const batch = await request("/api/handoffs", "POST", handoff({ project: "Notification QA" }));
  check("creating with a project (batch path) succeeds", batch.status === 201);
  last = await nextAttempt(last, "HTTP create with a project");

  created(await rpc("/mcp", "create_handoff", handoff()));
  last = await nextAttempt(last, "native MCP create");
  const nativeKey = crypto.randomUUID();
  created(await rpc("/mcp", "create_handoff", handoff({ requestKey: nativeKey })));
  last = await nextAttempt(last, "native MCP create with a request key");
  created(await rpc("/mcp", "create_handoff", handoff({ requestKey: nativeKey })));
  await stays(last, "a native MCP replay stays quiet");

  const issued = await request("/api/agent-tokens", "POST", { name: "Notification QA", expiresInDays: 1 });
  check("an Agent Token is issued", issued.status === 201);
  const agent = { Authorization: `Bearer ${issued.data.token}` };
  const agentKey = crypto.randomUUID();
  created(await rpc("/api/agent/mcp", "create_handoff", handoff({ requestKey: agentKey }), agent));
  last = await nextAttempt(last, "agent MCP create");
  created(await rpc("/api/agent/mcp", "create_handoff", handoff({ requestKey: agentKey }), agent));
  await stays(last, "an agent MCP replay stays quiet");

  created(await rpc("/api/agent/mcp", "create_handoff", handoff({ targetDevice: "any" }), agent));
  await stays(last, "a handoff for any device stays quiet by default");

  const target = withKey.data;
  const claimed = await request(`/api/handoffs/${target.id}`, "PATCH", { status: "claimed", version: target.version, device: "laptop" });
  check("claiming over HTTP succeeds", claimed.status === 200);
  await stays(last, "claiming stays quiet");
  const stale = await request(`/api/handoffs/${target.id}`, "PATCH", { status: "ready", version: target.version });
  check("a stale requeue is refused", stale.status === 409);
  await stays(last, "a refused requeue stays quiet");
  const requeued = await request(`/api/handoffs/${target.id}`, "PATCH", { status: "ready", version: claimed.data.version });
  check("requeueing over HTTP succeeds", requeued.status === 200 && requeued.data.status === "ready");
  last = await nextAttempt(last, "requeue");

  check("every handoff was saved although every push was refused", (await request("/api/handoffs")).data.handoffs.length === 7);

  // Progress: a browser bound to the sending device hears about the claim and the completion, through every entry point.
  check("the sending device is registered", (await request("/api/devices", "POST", { name: "Desktop", id: "desktop" })).status === 201);
  const sender = crypto.randomUUID(), senderWho = [sender, identity(owner)];
  sql(`INSERT INTO notification_subscriptions (owner_id, browser_id, device_id, endpoint, endpoint_hash, p256dh, auth, locale, created_at, updated_at, version, notify_progress) VALUES (${quote(owner)}, ${quote(sender)}, 'desktop', 'https://push.invalid/sender-never-contacted', 'synthetic-sender', 'synthetic', 'synthetic', 'en', ${Date.now()}, ${Date.now()}, 1, 'all');`);
  const sent = (await request("/api/handoffs", "POST", handoff({ title: "Progress check" }))).data;
  last = await nextAttempt(last, "the receiving browser hears about the new handoff");
  await stays(null, "the sending browser does not hear about its own new handoff", ...senderWho);
  const agentClaim = created(await rpc("/api/agent/mcp", "claim_handoff", { id: sent.id, device: "laptop", version: sent.version }, agent));
  let senderLast = await nextAttempt(0, "an agent MCP claim notifies the sender", ...senderWho);
  const finished = created(await rpc("/mcp", "complete_handoff", { id: sent.id, version: agentClaim.version, result: "Synthetic receipt" }));
  senderLast = await nextAttempt(senderLast, "a native MCP completion notifies the sender", ...senderWho);
  const progressPath = (browser, who = identity(owner)) => request(`/api/notifications/handoffs/${sent.id}?browserId=${browser}&kind=progress`, "GET", undefined, who);
  const progressInfo = await progressPath(sender);
  check("the sender reads the step, the claiming device and no receipt", progressInfo.status === 200 && progressInfo.data.status === "done" && progressInfo.data.version === finished.version
    && progressInfo.data.title === "Progress check" && progressInfo.data.device === "Laptop" && !JSON.stringify(progressInfo.data).includes("Synthetic receipt"));
  check("the receiving browser cannot read the sender's view", (await progressPath(browserId)).status === 404);
  check("another workspace cannot read it", (await progressPath(sender, identity(stranger))).status === 404);
  check("an undo over HTTP succeeds", (await request(`/api/handoffs/${sent.id}`, "PATCH", { status: "claimed", version: finished.version, undo: true })).status === 200);
  await stays(senderLast, "an undo stays quiet for the sender", ...senderWho);
  const own = (await request("/api/handoffs", "POST", handoff({ targetDevice: "any" }))).data;
  const ownClaim = await request(`/api/handoffs/${own.id}`, "PATCH", { status: "claimed", version: own.version, device: "desktop" });
  check("the sending device claims its own handoff over HTTP", ownClaim.status === 200);
  await stays(senderLast, "a handoff claimed on its own device stays quiet", ...senderWho);

  // Expiry reminders: a 1-day connection starts past its 1-day reminder, so only moving its expiry inside the hour makes one due.
  const reminderIdentity = identity(reminderOwner), reminderWho = [reminderBrowser, reminderIdentity];
  const asReminderOwner = (path, method, data) => request(path, method, data, reminderIdentity);
  check("a device is registered for the reminder check", (await asReminderOwner("/api/devices", "POST", { name: "Laptop", id: "laptop" })).status === 201);
  sql(`INSERT INTO notification_subscriptions (owner_id, browser_id, device_id, endpoint, endpoint_hash, p256dh, auth, locale, created_at, updated_at, version) VALUES (${quote(reminderOwner)}, ${quote(reminderBrowser)}, 'laptop', 'https://push.invalid/never-contacted', 'synthetic', 'synthetic', 'synthetic', 'en', ${now}, ${now}, 1);`);
  const expiring = await asReminderOwner("/api/agent-tokens", "POST", { name: "Expiring QA", expiresInDays: 1, deviceId: "laptop" });
  check("a 1-day connection is issued", expiring.status === 201);
  check("its first sweep, from the inbox, stays quiet", (await asReminderOwner("/api/handoffs")).status === 200);
  await stays(null, "a new 1-day connection is not reminded", ...reminderWho);
  const expiresAt = Date.now() + 30 * 60_000;
  sql(`UPDATE agent_tokens SET expires_at = ${expiresAt} WHERE id = ${quote(expiring.data.id)};`);
  // The previous sweep of this workspace was moments ago; the next one is allowed a minute later.
  await delay(61_000);
  created(await rpc("/api/agent/mcp", "list_handoffs", {}, { Authorization: `Bearer ${expiring.data.token}` }));
  const reminded = await nextAttempt(0, "an agent MCP request sends the due 1-hour reminder after its response", ...reminderWho);
  const info = await asReminderOwner(`/api/notifications/connections/${expiring.data.id}?browserId=${reminderBrowser}`);
  check("the reminder's display data names the connection and its expiry", info.status === 200 && info.data.name === "Expiring QA" && info.data.expiresAt === expiresAt);
  check("another workspace cannot read it", (await request(`/api/notifications/connections/${expiring.data.id}?browserId=${reminderBrowser}`, "GET", undefined, identity(stranger))).status === 404);
  await delay(61_000);
  check("a later sweep runs", (await asReminderOwner("/api/handoffs")).status === 200);
  await stays(reminded, "a reminder is sent once", ...reminderWho);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  const owners = [owner, stranger, reminderOwner].map(quote).join(", ");
  sql(`DELETE FROM notification_subscriptions WHERE owner_id IN (${owners});`);
  for (const table of ["handoffs", "agent_tokens", "connection_events", "devices"]) sql(`DELETE FROM ${table} WHERE owner_id IN (${owners});`);
}
