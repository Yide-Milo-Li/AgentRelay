// Exercise the real local HTTP/D1 path, including independent owners and racing receivers.
import assert from "node:assert/strict";
import { testRequest } from "../support/integration-http.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5177";
if (!new URL(base).hostname.match(/^(127\.0\.0\.1|localhost)$/)) throw new Error("Integration checks only run against a local database.");
const run = crypto.randomUUID();
const owner = `agentrelay-test-${run}`, stranger = `other-${run}`, crowded = `crowded-${run}`, pager = `pager-${run}`;
const ids = [], pagerIds = [];
const passed = [];
async function request(path, method = "GET", data, user = owner, extra = {}) {
  return testRequest(base + path, { method, headers: { ...(user ? { "oai-authenticated-user-id": user, "oai-authenticated-user-email": "test@sites.test" } : {}), "Content-Type": "application/json", ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
try {
  check("unauthenticated read rejected", (await request("/api/handoffs", "GET", undefined, null)).status === 401);
  check("the workspace route rejects anonymous callers", (await request("/api/workspace", "GET", undefined, null)).status === 401);
  const info = await request("/api/workspace");
  check("a private site reports the caller's own id for enabling sharing", info.status === 200 && info.data.shared === false && info.data.userId === owner);
  const content = "# 精确原文\r\n  spaces & 中文 🚀\n```sh\necho '$VALUE'\n```\n<script>alert(1)</script>\n";
  const input = { title: "Integration check", content, project: "AgentRelay QA", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: run };
  const created = await request("/api/handoffs", "POST", input);
  check("create persists exact Unicode, CRLF and trailing newline", created.status === 201 && created.data.content === content);
  const id = created.data.id; ids.push(id);
  check("readback preserves prompt bytes", (await request(`/api/handoffs/${id}`)).data.content === content);
  const download = await testRequest(base + `/api/handoffs/${id}/download`, { headers: { "oai-authenticated-user-id": owner } }, { format: "text" });
  check("authenticated text attachment preserves exact prompt", download.status === 200 && download.headers.get("Content-Disposition")?.includes("attachment") && download.text === content);
  check("another owner cannot download", (await request(`/api/handoffs/${id}/download`, "GET", undefined, stranger)).status === 404);
  check("retry returns the same record", (await request("/api/handoffs", "POST", input)).data.id === id);
  check("reused key with different content conflicts", (await request("/api/handoffs", "POST", { ...input, content: "different" })).status === 409);
  check("another owner cannot read", (await request(`/api/handoffs/${id}`, "GET", undefined, stranger)).status === 404);
  check("another owner sees an empty inbox", (await request("/api/handoffs", "GET", undefined, stranger)).data.handoffs.length === 0);
  check("another owner cannot change status", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed" }, stranger)).status === 404);
  check("another owner cannot delete", (await request(`/api/handoffs/${id}`, "DELETE", undefined, stranger)).status === 404);
  check("cross-origin browser write rejected", (await request("/api/handoffs", "POST", { ...input, requestKey: "csrf" }, owner, { Origin: "https://untrusted.example" })).status === 403);
  check("empty prompts rejected", (await request("/api/handoffs", "POST", { ...input, content: "  " })).status === 400);
  check("oversized prompts rejected", (await request("/api/handoffs", "POST", { ...input, content: "a".repeat(200001) })).status === 400);
  const claims = await Promise.all(["Desktop-A", "Desktop-B"].map(device => request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", device, version: 1 })));
  check("only one simultaneous receiver claims successfully", claims.filter(x => x.status === 200).length === 1 && claims.filter(x => x.status === 409).length === 1);
  check("stale completion rejected", (await request(`/api/handoffs/${id}`, "PATCH", { status: "done", version: 1 })).status === 409);
  check("claimed handoff can complete", (await request(`/api/handoffs/${id}`, "PATCH", { status: "done", version: 2 })).data.status === "done");
  const claimant = claims.find(x => x.status === 200).data.claimedBy;
  check("undo requires a version", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", undo: true })).status === 400);
  check("a stale undo is refused", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 2, undo: true })).status === 409);
  check("without undo, Done never moves back to Claimed", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 3, device: "Desktop-B" })).status === 409);
  const undoneDone = await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 3, device: "Elsewhere", undo: true });
  check("undoing a completion restores Claimed and keeps the original claimant", undoneDone.status === 200 && undoneDone.data.status === "claimed" && undoneDone.data.claimedBy === claimant && undoneDone.data.version === 4);
  const undoneClaim = await request(`/api/handoffs/${id}`, "PATCH", { status: "ready", version: 4, undo: true });
  check("undoing a claim returns to Ready without a claimant", undoneClaim.status === 200 && undoneClaim.data.status === "ready" && undoneClaim.data.claimedBy === null);
  check("undo never moves a Ready handoff", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 5, undo: true })).status === 409);
  check("another owner cannot undo", (await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 5, undo: true }, stranger)).status === 404);
  // Finish it again so the later inbox checks see the same states as before.
  await request(`/api/handoffs/${id}`, "PATCH", { status: "claimed", version: 5, device: "Desktop-A" });
  check("an undone handoff completes normally again", (await request(`/api/handoffs/${id}`, "PATCH", { status: "done", version: 6 })).data.status === "done");
  const rpc = async (method, params, user = owner) => (await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method, params }, user)).data;
  check("MCP discovery works", (await rpc("server/discover")).result.supportedVersions.includes("2026-07-28"));
  check("MCP exposes five tools", (await rpc("tools/list")).result.tools.length === 5);
  const mcpCreated = await rpc("tools/call", { name: "create_handoff", arguments: { ...input, requestKey: `${run}-mcp` } });
  const mcpRow = JSON.parse(mcpCreated.result.content[0].text); ids.push(mcpRow.id);
  // Writes answer with a summary: the prompt, receipt, image manifest and storage keys stay out of agent context.
  const summaryOnly = row => ["content", "result", "attachments", "ownerId", "requestKey"].every(key => !(key in row));
  check("MCP creates real persistent handoff", typeof mcpRow.id === "string" && mcpRow.version === 1 && mcpRow.status === "ready" && summaryOnly(mcpRow));
  const mcpRead = await rpc("tools/call", { name: "get_handoff", arguments: { id: mcpRow.id } });
  check("MCP full readback preserves raw text", JSON.parse(mcpRead.result.content[0].text).content === content);
  const mcpList = JSON.parse((await rpc("tools/call", { name: "list_handoffs", arguments: { status: "ready", targetDevice: "Desktop" } })).result.content[0].text);
  check("MCP filters unclaimed target-device inbox", mcpList.handoffs.length === 1 && mcpList.handoffs[0].id === mcpRow.id);
  check("MCP enforces owner isolation", (await rpc("tools/call", { name: "get_handoff", arguments: { id: mcpRow.id } }, stranger)).result.isError === true);
  check("MCP requires caller identity", (await rpc("tools/call", { name: "get_handoff", arguments: { id: mcpRow.id } }, null)).result.isError === true);
  const claimed = JSON.parse((await rpc("tools/call", { name: "claim_handoff", arguments: { id: mcpRow.id, device: "Desktop", version: 1 } })).result.content[0].text);
  check("MCP claim changes real record", claimed.status === "claimed" && claimed.version === 2 && claimed.claimedBy === "Desktop" && summaryOnly(claimed));
  const completed = JSON.parse((await rpc("tools/call", { name: "complete_handoff", arguments: { id: mcpRow.id, version: 2 } })).result.content[0].text);
  check("MCP completion changes real record", completed.status === "done" && completed.version === 3 && summaryOnly(completed));
  check("the web route still returns the full record", (await request(`/api/handoffs/${mcpRow.id}`, "GET")).data.content === content);
  const mcpUndo = await rpc("tools/call", { name: "claim_handoff", arguments: { id: mcpRow.id, device: "Desktop", version: 3, undo: true } });
  check("MCP ignores undo and cannot reclaim a Done handoff", mcpUndo.result.isError === true && mcpUndo.result.structuredContent.error.status === 409);

  // list_handoffs pages are cut in SQL: 50 rows at a time, with previews and sizes computed by SQLite.
  const pagerList = async args => JSON.parse((await rpc("tools/call", { name: "list_handoffs", arguments: args }, pager)).result.content[0].text);
  const pagerPrompts = ["🚀".repeat(200), "before\u0000after"];
  for (let i = 0; i < 101; i++) {
    const row = await request("/api/handoffs", "POST", { title: `Page ${i}`, content: pagerPrompts[i] ?? `row ${i}`, sourceDevice: "Laptop",
      targetDevice: i % 2 ? "Desktop" : "Tablet", requestKey: `${run}-page-${i}` }, pager);
    assert.equal(row.status, 201); pagerIds.push(row.data.id);
  }
  const pages = [];
  for (let offset = 0; offset !== null;) { const page = await pagerList({ offset }); pages.push(page); offset = page.nextOffset; }
  const pagedRows = pages.flatMap(page => page.handoffs);
  check("list_handoffs pages 101 rows as 50, 50 and 1", pages.map(page => page.handoffs.length).join() === "50,50,1" && pages.map(page => page.nextOffset).join() === "50,100,");
  check("pages hold every row once, newest first", new Set(pagedRows.map(row => row.id)).size === 101 && pagedRows.every(row => pagerIds.includes(row.id))
    && pagedRows.every((row, i) => i === 0 || pagedRows[i - 1].createdAt >= row.createdAt));
  const [emojiRow, nulRow, plainRow] = pagerIds.slice(0, 3).map(id => pagedRows.find(row => row.id === id));
  check("previews are cut by Unicode character and never split an emoji", emojiRow.preview === "🚀".repeat(180) && emojiRow.characters === 200);
  check("a prompt with a NUL character still lists, with its size as a hint", !!nulRow && nulRow.characters <= pagerPrompts[1].length);
  check("list rows leave empty fields out", plainRow.preview === "row 2" && plainRow.characters === 5
    && ["claimedBy", "project", "projectId", "branch", "baseCommit", "replyToId", "attachmentCount", "resultPreview", "content", "attachments", "ownerId"].every(key => !(key in plainRow)));
  const desktopPage = await pagerList({ targetDevice: "Desktop" }), shifted = await pagerList({ targetDevice: "Desktop", offset: 1 });
  check("a filtered page of exactly 50 rows has no next page", desktopPage.handoffs.length === 50 && desktopPage.nextOffset === null
    && desktopPage.handoffs.every(row => row.targetDevice === "Desktop"));
  check("a page of 49 rows has no next page", shifted.handoffs.length === 49 && shifted.nextOffset === null);
  check("the 500-row window still ends paging", (await pagerList({ offset: 500 })).handoffs.length === 0);
  const pagerInbox = (await request("/api/handoffs", "GET", undefined, pager)).data.handoffs;
  check("the web inbox still returns full rows", pagerInbox.length === 101 && pagerInbox.find(row => row.id === pagerIds[0]).content === pagerPrompts[0]);

  // Device registry: CRUD, owner isolation, collisions and optimistic concurrency.
  // Start from an empty inbox so registering Laptop or Desktop adopts nothing from the checks above.
  for (const old of ids.splice(0)) await request(`/api/handoffs/${old}`, "DELETE");
  const devices = (method, path = "", data, user = owner, extra) => request(`/api/devices${path}`, method, data, user, extra);
  check("unauthenticated device list rejected", (await devices("GET", "", undefined, null)).status === 401);
  check("unauthenticated device creation rejected", (await devices("POST", "", { name: "Laptop" }, null)).status === 401);
  check("cross-origin device creation rejected", (await devices("POST", "", { name: "Laptop" }, owner, { Origin: "https://untrusted.example" })).status === 403);
  for (const [label, body] of [["empty name", { name: " " }], ["overlong name", { name: "n".repeat(81) }], ["control character", { name: "bad\tname" }],
    ["reserved name", { name: "Any device" }], ["reserved Chinese name", { name: "任意设备" }], ["invalid id", { name: "X", id: "Bad Id" }], ["reserved id", { name: "X", id: "any" }], ["unknown colour", { name: "X", line: "pink" }]])
    check(`device ${label} rejected`, (await devices("POST", "", body)).status === 400);
  const laptop = await devices("POST", "", { name: "  Laptop " });
  check("device creation derives the slug id and a colour", laptop.status === 201 && laptop.data.id === "laptop" && laptop.data.name === "Laptop" && laptop.data.line === "amber" && laptop.data.version === 1);
  check("duplicate name conflicts case-insensitively", (await devices("POST", "", { name: "LAPTOP" })).status === 409);
  check("duplicate id conflicts", (await devices("POST", "", { name: "Work laptop", id: "laptop" })).status === 409);
  const bang = await devices("POST", "", { name: "Laptop!" });
  check("a taken slug gets a numeric suffix", bang.status === 201 && bang.data.id === "laptop-2");
  const desk = await devices("POST", "", { name: "Desk", id: "desktop", line: "blue" });
  check("explicit id and colour are honoured", desk.status === 201 && desk.data.id === "desktop" && desk.data.line === "blue");
  check("a name cannot equal another device's id", (await devices("POST", "", { name: "Desktop", id: "pc" })).status === 409);
  check("an id cannot equal another device's name", (await devices("POST", "", { name: "Pc", id: "desk" })).status === 409);
  const chinese = await devices("POST", "", { name: "笔记本" });
  check("non-ASCII names fall back to a generated id", chinese.status === 201 && /^device-[a-z2-7]{4}$/.test(chinese.data.id));
  const listing = (await devices("GET")).data.devices;
  check("device list returns every registered device", listing.map(d => d.id).sort().join() === ["desktop", "laptop", "laptop-2", chinese.data.id].sort().join());
  check("another owner sees an empty registry", (await devices("GET", "", undefined, stranger)).data.devices.length === 0);
  check("another owner can register the same slug", (await devices("POST", "", { name: "Laptop" }, stranger)).data.id === "laptop");
  check("another owner cannot read a device", (await devices("GET", "/laptop-2", undefined, stranger)).status === 404);
  check("another owner cannot rename a device", (await devices("PATCH", "/laptop-2", { version: 1, name: "Hijack" }, stranger)).status === 404);
  check("another owner cannot delete a device", (await devices("DELETE", "/laptop-2", { version: 1 }, stranger)).status === 404);
  check("missing device is 404", (await devices("GET", "/nope")).status === 404);

  check("rename requires a version", (await devices("PATCH", "/laptop-2", { name: "Spare" })).status === 400);
  check("a device id cannot be changed", (await devices("PATCH", "/laptop-2", { version: 1, id: "other", name: "Spare" })).status === 400);
  check("an empty patch is rejected", (await devices("PATCH", "/laptop-2", { version: 1 })).status === 400);
  check("rename to another device's name conflicts", (await devices("PATCH", "/laptop-2", { version: 1, name: "laptop" })).status === 409);
  check("rename to another device's id conflicts", (await devices("PATCH", "/laptop-2", { version: 1, name: "Desktop" })).status === 409);
  check("invalid colour rejected on update", (await devices("PATCH", "/laptop-2", { version: 1, line: "pink" })).status === 400);
  const renamed = await devices("PATCH", "/laptop-2", { version: 1, name: "Spare laptop", line: "violet" });
  check("rename and recolour keep the id and bump the version", renamed.status === 200 && renamed.data.id === "laptop-2" && renamed.data.name === "Spare laptop" && renamed.data.line === "violet" && renamed.data.version === 2);
  check("a stale version conflicts", (await devices("PATCH", "/laptop-2", { version: 1, name: "Stale" })).status === 409);
  const racing = await Promise.all(["Racer A", "Racer B"].map(name => devices("PATCH", "/laptop-2", { version: 2, name })));
  check("only one simultaneous rename wins", racing.filter(r => r.status === 200).length === 1 && racing.filter(r => r.status === 409).length === 1);
  check("a device may be renamed to its own id", (await devices("PATCH", "/laptop", { version: 1, name: "laptop" })).status === 200);

  // Handoffs accept a device id or a registered name and store the registry link next to the snapshot name.
  const linked = { title: "Linked route", content: "device linkage", project: "AgentRelay QA", sourceDevice: "laptop", targetDevice: "desk", requestKey: `${run}-linked` };
  const linkedRow = await request("/api/handoffs", "POST", linked); ids.push(linkedRow.data.id);
  check("handoffs resolve ids to registry names", linkedRow.status === 201 && linkedRow.data.sourceDevice === "laptop" && linkedRow.data.sourceDeviceId === "laptop" && linkedRow.data.targetDevice === "Desk" && linkedRow.data.targetDeviceId === "desktop");
  const byName = await request("/api/handoffs", "POST", { ...linked, sourceDevice: "  LAPTOP", targetDevice: "DESK", requestKey: `${run}-by-name` }); ids.push(byName.data.id);
  check("handoffs resolve registered names case-insensitively", byName.data.sourceDeviceId === "laptop" && byName.data.targetDeviceId === "desktop");
  const stranded = await request("/api/handoffs", "POST", { ...linked, sourceDevice: "Tablet", targetDevice: "Build box", requestKey: `${run}-unregistered` }); ids.push(stranded.data.id);
  check("unregistered devices are still accepted as plain names", stranded.status === 201 && stranded.data.sourceDevice === "Tablet" && stranded.data.sourceDeviceId === null && stranded.data.targetDeviceId === null);
  const anyRow = await request("/api/handoffs", "POST", { ...linked, targetDevice: "ANY", requestKey: `${run}-any` }); ids.push(anyRow.data.id);
  check("any maps to the reserved target without a device id", anyRow.data.targetDevice === "任意设备" && anyRow.data.targetDeviceId === null);
  const defaulted = await request("/api/handoffs", "POST", { title: "Defaults", content: "x", sourceDevice: "laptop", requestKey: `${run}-default` }); ids.push(defaulted.data.id);
  check("a missing target still defaults to the any-device label", defaulted.data.targetDevice === "任意设备");
  const detail = await devices("GET", "/desktop");
  check("device detail reports how many handoffs use it", detail.status === 200 && detail.data.usage.totalHandoffs === 2 && detail.data.usage.openHandoffs === 2 && detail.data.usage.connections === 0);

  const renameDesk = await devices("PATCH", "/desktop", { version: 1, name: "Studio desktop" });
  check("renaming a device keeps its handoffs linked", renameDesk.status === 200 && (await request(`/api/handoffs/${linkedRow.data.id}`)).data.targetDeviceId === "desktop");
  const retry = await request("/api/handoffs", "POST", linked);
  check("a retry after a rename returns the same handoff", retry.status === 201 && retry.data.id === linkedRow.data.id);
  const retryByNewName = await request("/api/handoffs", "POST", { ...linked, targetDevice: "Studio desktop" });
  check("a retry using the new name returns the same handoff", retryByNewName.data.id === linkedRow.data.id);
  check("a retry with a different device conflicts", (await request("/api/handoffs", "POST", { ...linked, targetDevice: "laptop" })).status === 409);
  const listFor = async value => JSON.parse((await rpc("tools/call", { name: "list_handoffs", arguments: { targetDevice: value } })).result.content[0].text).handoffs;
  const mine = rows => rows.filter(row => [linkedRow.data.id, byName.data.id].includes(row.id)).length;
  check("list filter accepts the device id", mine(await listFor("desktop")) === 2);
  check("list filter accepts the current name", mine(await listFor("studio DESKTOP")) === 2);
  check("list filter still matches the stored snapshot name", mine(await listFor("Desk")) === 2);
  check("list filter for any matches the reserved target", (await listFor("any")).some(row => row.id === anyRow.data.id));
  check("unregistered filters keep the exact match", (await listFor("Build box")).map(row => row.id).join() === stranded.data.id);

  const adopted = await devices("POST", "", { name: "Tablet" });
  const adoptedRow = (await request(`/api/handoffs/${stranded.data.id}`)).data;
  check("registering a name adopts matching legacy handoffs", adopted.status === 201 && adoptedRow.sourceDeviceId === "tablet" && adoptedRow.targetDeviceId === null && adoptedRow.version === 1);

  const claimedByAlias = await rpc("tools/call", { name: "claim_handoff", arguments: { id: linkedRow.data.id, device: "LAPTOP", version: 1 } });
  const claimedRow = JSON.parse(claimedByAlias.result.content[0].text);
  check("claiming by device id stores the registry name and link", claimedRow.claimedBy === "laptop" && claimedRow.claimedByDeviceId === "laptop");
  const requeued = await request(`/api/handoffs/${linkedRow.data.id}`, "PATCH", { status: "ready", version: claimedRow.version });
  check("requeueing clears the claimant link", requeued.data.claimedBy === null && requeued.data.claimedByDeviceId === null);
  await request(`/api/handoffs/${linkedRow.data.id}`, "PATCH", { status: "claimed", version: requeued.data.version, device: "laptop" });

  // Deleting a device detaches handoffs in one batch and keeps readable snapshot names.
  const before = (await request(`/api/handoffs/${linkedRow.data.id}`)).data;
  check("delete requires a version", (await devices("DELETE", "/desktop", {})).status === 400);
  check("delete rejects an unknown connection action", (await devices("DELETE", "/desktop", { version: 2, connections: "destroy" })).status === 400);
  check("delete with a stale version conflicts and detaches nothing", (await devices("DELETE", "/desktop", { version: 1 })).status === 409
    && (await request(`/api/handoffs/${linkedRow.data.id}`)).data.targetDeviceId === "desktop");
  const removed = await devices("DELETE", "/desktop", { version: 2 });
  const after = (await request(`/api/handoffs/${linkedRow.data.id}`)).data;
  check("deleting a device reports what it detached", removed.status === 200 && removed.data.id === "desktop" && removed.data.detachedHandoffs === 2 && removed.data.unboundConnections === 0);
  check("detached handoffs keep the current name as a snapshot and lose the link", after.targetDevice === "Studio desktop" && after.targetDeviceId === null && after.sourceDeviceId === "laptop");
  check("detaching does not bump the handoff version", after.version === before.version && after.updatedAt === before.updatedAt);
  check("a deleted device is gone", (await devices("GET", "/desktop")).status === 404 && !(await devices("GET")).data.devices.some(d => d.id === "desktop"));
  check("deleting a deleted device is a 404", (await devices("DELETE", "/desktop", { version: 2 })).status === 404);
  const laptopNow = (await devices("GET", "/laptop")).data.device;
  const claimedAfter = await devices("DELETE", "/laptop", { version: laptopNow.version });
  const claimedSnapshot = (await request(`/api/handoffs/${linkedRow.data.id}`)).data;
  check("deleting the claimant device snapshots its name", claimedAfter.status === 200 && claimedSnapshot.claimedBy === "laptop" && claimedSnapshot.claimedByDeviceId === null && claimedSnapshot.sourceDevice === "laptop" && claimedSnapshot.sourceDeviceId === null);
  const readopt = await devices("POST", "", { name: "Studio desktop", id: "desktop" });
  check("a later device with the same name re-adopts the snapshot rows", readopt.status === 201 && (await request(`/api/handoffs/${linkedRow.data.id}`)).data.targetDeviceId === "desktop");

  // Registry size limit, on its own owner.
  for (let i = 1; i <= 50; i++) {
    const response = await devices("POST", "", { name: `Crowd ${i}` }, crowded);
    if (response.status !== 201) throw new Error(`device ${i} was rejected: ${response.status}`);
  }
  check("the registry is limited to 50 devices", (await devices("POST", "", { name: "One too many" }, crowded)).status === 409);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  for (const id of ids) if (id) await request(`/api/handoffs/${id}`, "DELETE");
  for (const id of pagerIds) await request(`/api/handoffs/${id}`, "DELETE", undefined, pager);
  // Device rows have no cascade from the API, so remove each owner's registry through the same CAS delete.
  for (const user of [owner, stranger, crowded]) {
    const registry = (await request("/api/devices", "GET", undefined, user)).data?.devices ?? [];
    for (const device of registry) await request(`/api/devices/${device.id}`, "DELETE", { version: device.version }, user);
  }
}
