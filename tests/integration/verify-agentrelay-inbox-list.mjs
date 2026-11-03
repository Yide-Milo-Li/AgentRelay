// The browser's inbox list over the built Worker: summary pages (GET /api/handoffs?view=summary), SQL filters and search,
// cursor paging, project counts, workspace isolation, the query plans that keep a poll's reads bounded, and the
// deprecated full list that open tabs still use.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execTestFileSync as execFileSync } from "../support/integration-process.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Inbox list checks only run against a local database.");
const run = crypto.randomUUID(), owner = `inbox-qa-${run}`, stranger = `inbox-other-${run}`;
const ids = [], passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
const web = (path, method = "GET", data, user = owner) => testRequest(base + path, { method,
  headers: { ...identityHeaders(user), "Content-Type": "application/json", Connection: "close" }, body: data === undefined ? undefined : JSON.stringify(data) });
const list = async (query = "", user = owner) => (await web(`/api/handoffs?view=summary${query}`, "GET", undefined, user)).data;
const titles = page => page.handoffs.map(row => row.title);
const sql = command => {
  const output = execFileSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local",
    "--config", process.env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json", "--persist-to", process.env.AGENTRELAY_TEST_STATE ?? ".wrangler/state", "--json", "--command", command],
  { stdio: "pipe" }).toString();
  return JSON.parse(output.slice(output.indexOf("["))).flatMap(entry => entry.results ?? []);
};
async function create(title, fields = {}) {
  // A few milliseconds apart, so newest-first order never depends on the id tiebreak.
  await delay(5);
  const response = await web("/api/handoffs", "POST", { title, content: `Prompt of ${title}`, sourceDevice: "laptop", targetDevice: "desktop", requestKey: `${run}-${title}`, ...fields });
  assert.equal(response.status, 201, `${title}: ${JSON.stringify(response.data)}`);
  ids.push(response.data.id);
  return response.data;
}
const move = async (row, status, extra = {}) => (await web(`/api/handoffs/${row.id}`, "PATCH", { status, version: row.version, device: "desktop", ...extra })).data;
try {
  for (const device of [{ name: "Laptop", id: "laptop" }, { name: "Desktop", id: "desktop" }]) assert.equal((await web("/api/devices", "POST", device)).status, 201);
  // Oldest first, so the newest-first order below is known. The search word sits past the 180-character preview.
  const alpha = await create("Alpha one", { project: "Alpha", content: `${"x".repeat(400)} NeedleWord deep in the prompt` });
  const anyTarget = await create("Any device", { targetDevice: "any" });
  const claimed = await move(await create("Claimed work"), "claimed");
  const done = await move(await move(await create("Finished work", { project: "Alpha" }), "claimed"), "done", { result: "## Summary\nDone." });
  for (const n of [1, 2, 3]) await create(`Ready ${n}`);
  const alphaId = (await web(`/api/handoffs/${alpha.id}`)).data.projectId;

  const inbox = await list();
  check("the default scope is the inbox, newest first", titles(inbox).join("|") === "Ready 3|Ready 2|Ready 1|Claimed work|Any device|Alpha one");
  check("rows are summaries: no prompt, receipt or manifest", inbox.handoffs.every(row => !("content" in row) && !("result" in row) && !("attachments" in row)));
  check("rows carry the version, a bounded preview and the prompt's size", inbox.handoffs.every(row => row.version >= 1 && row.preview.length <= 180)
    && inbox.handoffs.find(row => row.id === alpha.id).characters === 430);
  check("one page, no next cursor, and the inbox badge", inbox.nextCursor === null && inbox.counts.open === 6);
  const doneList = await list("&scope=done");
  check("the done scope lists only finished handoffs, with the receipt's size", titles(doneList).join() === "Finished work" && doneList.handoffs[0].resultCharacters === 16);
  check("the badge counts the inbox in every scope", doneList.counts.open === 6);

  check("status narrows the inbox to ready", titles(await list("&status=ready")).join("|") === "Ready 3|Ready 2|Ready 1|Any device|Alpha one");
  check("status narrows the inbox to claimed", titles(await list("&status=claimed")).join() === "Claimed work" && claimed.status === "claimed");
  check("status outside the open scope is refused", (await web("/api/handoffs?view=summary&scope=done&status=ready")).status === 400);
  check("target filters by device id", titles(await list("&target=desktop")).length === 5 && !titles(await list("&target=desktop")).includes("Any device"));
  check("target any finds handoffs for any device", titles(await list("&target=any")).join() === "Any device");
  check("project filters by id, across scopes", titles(await list(`&project=${alphaId}`)).join() === "Alpha one" && titles(await list(`&scope=done&project=${alphaId}`)).join() === "Finished work");
  check("project none finds handoffs without one", titles(await list("&project=none")).length === 5 && !titles(await list("&project=none")).includes("Alpha one"));
  check("search finds text past the preview", titles(await list("&q=NeedleWord")).join() === "Alpha one");
  check("search folds ASCII case and matches titles", titles(await list("&q=needleword")).join() === "Alpha one" && titles(await list("&q=claimed%20WORK")).join() === "Claimed work");
  check("search combines with the scope", titles(await list("&scope=done&q=finished")).join() === "Finished work" && (await list("&q=finished")).handoffs.length === 0);
  check("search text is data, not SQL", (await list(`&q=${encodeURIComponent("') OR 1=1 --")}`)).handoffs.length === 0);

  // Paging continues after the last row; a handoff created between pages goes to the top and shifts nothing.
  const first = await list("&limit=2");
  check("a page stops at its limit and names the next", titles(first).join("|") === "Ready 3|Ready 2" && typeof first.nextCursor === "string");
  await create("Arrived between pages");
  const second = await list(`&limit=2&cursor=${first.nextCursor}`);
  check("the next page continues where the first stopped", titles(second).join("|") === "Ready 1|Claimed work");
  const last = await list(`&limit=10&cursor=${second.nextCursor}`);
  check("the last page has no next cursor", titles(last).join("|") === "Any device|Alpha one" && last.nextCursor === null);
  check("a poll for the loaded window sees the new handoff on top", titles(await list("&limit=4"))[0] === "Arrived between pages");

  for (const [name, query] of [["an invalid cursor", "&cursor=not-a-cursor"], ["limit 0", "&limit=0"], ["limit above 500", "&limit=501"],
    ["a 201-character search", `&q=${"a".repeat(201)}`], ["an unknown scope", "&scope=all"]])
    check(`${name} is refused`, (await web(`/api/handoffs?view=summary${query}`)).status === 400);
  check("an unknown view is refused", (await web("/api/handoffs?view=everything")).status === 400);

  const counts = view => web(`/api/handoffs?view=project-counts&scope=${view}`).then(response => response.data.projects);
  const open = await counts("open"), finished = await counts("done"), all = await counts("all");
  check("project counts per scope", open[alphaId] === 1 && open.none === 6 && finished[alphaId] === 1 && !finished.none && all[alphaId] === 2 && all.none === 6);

  const strangerPage = await list("", stranger);
  check("another workspace sees none of it", strangerPage.handoffs.length === 0 && strangerPage.counts.open === 0 && (await list(`&q=NeedleWord`, stranger)).handoffs.length === 0);
  check("another workspace's cursor only pages its own rows", (await list(`&cursor=${first.nextCursor}`, stranger)).handoffs.length === 0);
  check("another workspace counts nothing", Object.keys((await web("/api/handoffs?view=project-counts&scope=all", "GET", undefined, stranger)).data.projects).length === 0);

  // Tabs opened before the summary list keep polling the full list until they reload.
  const legacy = (await web("/api/handoffs")).data.handoffs;
  check("the plain list still returns full records", legacy.length === 8 && legacy.find(row => row.id === alpha.id).content.endsWith("NeedleWord deep in the prompt")
    && legacy.find(row => row.id === done.id).result === "## Summary\nDone." && Array.isArray(legacy[0].attachments));

  const reply = await create("A reply", { replyTo: anyTarget.id, content: "Question", title: undefined });
  const thread = (await web(`/api/handoffs/${reply.id}`)).data.thread;
  check("thread entries name their devices' registry ids", thread.items.length === 2 && thread.items.every(item => "sourceDeviceId" in item && "targetDeviceId" in item)
    && thread.items.find(item => item.id === reply.id).targetDeviceId === "desktop" && thread.items.find(item => item.id === anyTarget.id).targetDeviceId === null);

  // A poll's reads stay bounded. Each status's page (the server runs one per status) walks the status index newest
  // first and stops at the limit, never sorting; the inbox badge counts open rows from that index alone. The SQL
  // mirrors the shape the server sends: the same conditions, order and kinds of columns.
  const plan = query => sql(`EXPLAIN QUERY PLAN ${query}`).map(row => row.detail).join(" | ");
  const active = "owner_id = 'x' AND (expires_at IS NULL OR expires_at > 0)";
  const pagePlans = ["done", "ready", "claimed"].map(status => plan(`SELECT id, title, substr(content, 1, 180) AS preview FROM handoffs WHERE ${active} AND status = '${status}' ORDER BY created_at DESC, id DESC LIMIT 51`));
  const countPlan = plan(`SELECT count(*) FROM handoffs WHERE ${active} AND status IN ('ready', 'claimed')`);
  // The plans are part of the failure message, so a regression shows what SQLite chose instead.
  const bounded = text => text.includes("USING INDEX handoffs_owner_status_created (owner_id=? AND status=?)") && !text.includes("TEMP B-TREE");
  const covered = countPlan.includes("USING COVERING INDEX handoffs_owner_status_created");
  assert.ok(pagePlans.every(bounded), `page plans: ${pagePlans.join(" || ")}`);
  assert.ok(covered, `count plan: ${countPlan}`);
  check("each status's page walks the status index without sorting", pagePlans.every(bounded));
  check("the inbox count reads only the status index", covered);
  console.log(JSON.stringify({ passed: passed.length, checks: passed, plans: { pages: pagePlans, count: countPlan } }, null, 2));
} finally {
  for (const id of ids.reverse()) await web(`/api/handoffs/${id}`, "DELETE");
  for (const device of (await web("/api/devices")).data?.devices ?? []) await web(`/api/devices/${device.id}`, "DELETE", { version: device.version, connections: "unbind" });
}
