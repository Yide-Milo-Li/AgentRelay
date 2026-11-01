// Image handoffs against the built Worker with real local D1 and R2. Every owner is a disposable synthetic identity.
import assert from "node:assert/strict";
import { spawnTest } from "../support/integration-process.mjs";
import { executeLocalSql, readLocalR2Object } from "../support/local-storage-fixtures.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asAnimated, corrupt, flat, fromPixels, padTo } from "../support/image-fixtures.mjs";
import { assertSetIsValid, buildVerificationSet } from "../support/client-verification-set.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Attachment checks require a local Worker and database.");
const run = crypto.randomUUID(), owner = `image-qa-${run}`, stranger = `image-other-${run}`;
const passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); console.log(`PASS ${name}`); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = async command => (await executeLocalSql(command))[0].results;
/** Read an object straight out of the local R2 store: its bytes, or null when the key does not exist. */
const r2Object = id => readLocalR2Object(`a/${id}`);
const identity = user => ({ "oai-authenticated-user-id": user });
const bearer = token => ({ Authorization: `Bearer ${token}` });

/** A single bounded attempt; proxy failures must remain visible during acceptance. */
async function call(path, { method = "GET", headers = {}, body, json } = {}) {
  return testRequest(base + path, { method, duplex: "half",
    headers: { Connection: "close", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body }, { format: "auto" });
}
const upload = (bytes, { user = owner, key = crypto.randomUUID(), name = "shot.png", type, extra = {}, route = "/api/attachments", auth } = {}) =>
  call(route, { method: "POST", headers: { ...(auth ?? identity(user)), "X-Upload-Key": key, "X-Filename": encodeURIComponent(name), ...(type ? { "Content-Type": type } : {}), ...extra }, body: bytes });
const web = (path, method = "GET", json, user = owner, extra = {}) => call(path, { method, json, headers: { ...identity(user), ...extra } });
const mime = format => `image/${format}`;
const mustUpload = async (bytes, options) => { const response = await upload(bytes, options); assert.ok(response.status === 201 || response.status === 200, `upload failed: ${response.status} ${JSON.stringify(response.data)}`); return response.data; };
const route = { sourceDevice: "Laptop", targetDevice: "Desktop", project: "Image QA" };
const createWith = (extra, user = owner) => web("/api/handoffs", "POST", { title: "Image check", requestKey: crypto.randomUUID(), ...route, ...extra }, user);
const handoffCount = async user => (await sql(`SELECT COUNT(*) AS n FROM handoffs WHERE owner_id = ${quote(user)}`))[0].n;
const attachmentRows = async user => await sql(`SELECT id, handoff_id, position, state, object_key FROM attachments WHERE owner_id = ${quote(user)}`);
let token, strangerToken;
const agentHeaders = () => bearer(token);
const rpc = (name, args, auth = bearer(token), method = "tools/call") => call("/api/agent/mcp", { method: "POST", headers: auth,
  json: { jsonrpc: "2.0", id: 1, method, ...(method === "tools/call" ? { params: { name, arguments: args } } : {}) } });
const tool = response => { assert.equal(response.status, 200); assert.ok(!response.data.result.isError, response.data.result.content?.[0]?.text); return response.data.result; };
const toolJson = response => JSON.parse(tool(response).content[0].text);

try {
  // ---- authentication, origin and isolation ------------------------------------------------------------------
  const png = await flat({ format: "png", width: 12, height: 9 });
  check("anonymous web upload is rejected", (await upload(png, { auth: {} })).status === 401);
  check("platform identity alone cannot use the Agent upload endpoint", (await upload(png, { route: "/api/agent/attachments", auth: identity(owner) })).status === 401);
  check("malformed Agent Token is rejected on upload", (await upload(png, { route: "/api/agent/attachments", auth: bearer("agentrelay_invalid") })).status === 401);
  check("cross-origin web upload is rejected", (await upload(png, { extra: { Origin: "https://untrusted.example" } })).status === 403);
  check("the Agent upload endpoint does not accept GET", (await call("/api/agent/attachments")).status === 405);
  token = (await web("/api/agent-tokens", "POST", { name: "Images", expiresInDays: 1 })).data.token;
  strangerToken = (await web("/api/agent-tokens", "POST", { name: "Other" }, stranger)).data.token;
  check("personal tokens issued", /^agentrelay_[a-f0-9]{64}$/.test(token) && /^agentrelay_[a-f0-9]{64}$/.test(strangerToken));

  // ---- upload: formats, metadata, idempotency -----------------------------------------------------------------
  const originals = {};
  for (const format of ["png", "jpeg", "webp"]) {
    const bytes = await fromPixels({ format, width: 40, height: 30, pixel: (x, y) => [x * 6, y * 8, (x + y) * 3] });
    const info = await mustUpload(bytes, { name: `pixels.${format}`, type: mime(format) });
    originals[format] = { bytes, info };
    check(`${format}: upload returns exact metadata without private fields`, info.mimeType === mime(format) && info.width === 40 && info.height === 30 && info.bytes === bytes.length
      && info.sha256 === sha256(bytes) && info.filename === `pixels.${format}` && info.position === null && !/ownerId|objectKey|uploadKey|owner_id|object_key/.test(JSON.stringify(info)));
  }
  check("the stored object holds the exact original bytes", sha256(await r2Object(originals.png.info.id)) === sha256(originals.png.bytes));
  const agentInfo = await mustUpload(png, { route: "/api/agent/attachments", auth: agentHeaders(), name: "agent.png" });
  check("Agent Token upload succeeds for the same workspace", agentInfo.bytes === png.length);
  const keyed = crypto.randomUUID(), first = await upload(png, { key: keyed }), replay = await upload(png, { key: keyed });
  check("the same key and image replays the existing upload", first.status === 201 && replay.status === 200 && replay.data.id === first.data.id);
  const conflicting = await upload(await flat({ format: "png", width: 5, height: 5 }), { key: keyed });
  check("the same key with a different image conflicts", conflicting.status === 409);
  check("an unrelated owner may reuse the same key independently", (await upload(png, { key: keyed, user: stranger })).status === 201);
  check("a missing upload key is rejected", (await call("/api/attachments", { method: "POST", headers: identity(owner), body: png })).status === 400);
  check("path components and controls are removed from filenames", (await mustUpload(png, { name: "C:\\Users\\me\\..\\evil\u0007.png" })).filename === "evil.png");

  // ---- validation: the agreed boundaries ---------------------------------------------------------------------
  const reject = async (name, bytes, status, options) => { const response = await upload(bytes, options); check(name, response.status === status && typeof response.data?.error === "string"); return response; };
  for (const format of ["png", "jpeg", "webp"]) {
    const exact = padTo(await flat({ format, width: 32, height: 32 }), format, 1_048_576);
    check(`${format}: exactly 1,048,576 bytes is accepted`, (await upload(exact)).status === 201);
  }
  const tooBig = await reject("png: 1,048,577 bytes is rejected with 413 and names both numbers", padTo(await flat({ format: "png", width: 32, height: 32 }), "png", 1_048_577), 413);
  check("the size message states the actual size and the limit", /1,048,577/.test(tooBig.data.error) && /1,048,576/.test(tooBig.data.error));
  const stream = bytes => new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 65_536) controller.enqueue(bytes.subarray(i, i + 65_536)); controller.close(); } });
  const chunked = await upload(stream(new Uint8Array(1_048_577).fill(7)), {});
  check("a streamed body without Content-Length is bounded as it is read", chunked.status === 413);
  for (const format of ["png", "jpeg", "webp"]) {
    check(`${format}: longest edge 2560 is accepted`, (await upload(await flat({ format, width: 2560, height: 1 }))).status === 201);
    await reject(`${format}: longest edge 2561 is rejected`, await flat({ format, width: 2561, height: 1 }), 422);
  }
  check("exactly 4,000,000 pixels is accepted", (await upload(await flat({ format: "png", width: 2000, height: 2000 }))).status === 201);
  const pixels = await reject("4,000,001+ pixels is rejected", await flat({ format: "png", width: 2000, height: 2001 }), 422);
  check("the pixel message states count and limit", /4,002,000/.test(pixels.data.error) && /4,000,000/.test(pixels.data.error));
  await reject("GIF is unsupported", new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"), 415);
  await reject("SVG is unsupported", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), 415);
  await reject("an empty body is rejected", new Uint8Array(), 422);
  await reject("a truncated PNG is corrupt", corrupt.truncate(await flat({ format: "png", width: 30, height: 30 })), 422);
  await reject("a damaged JPEG is corrupt", corrupt.truncate(await flat({ format: "jpeg", width: 30, height: 30 }), 40), 422);
  await reject("an animated PNG is rejected", asAnimated(await flat({ format: "png" }), "png"), 422);
  await reject("an animated WebP is rejected", asAnimated(await flat({ format: "webp" }), "webp"), 422);
  await reject("a declared type that contradicts the bytes is rejected", png, 415, { type: "image/jpeg" });
  await reject("a declared non-image type is rejected", png, 415, { type: "text/plain" });
  check("octet-stream is accepted because the bytes decide", (await upload(png, { type: "application/octet-stream" })).status === 201);

  // ---- creation: text, images, order, atomicity --------------------------------------------------------------
  const text = "# Task\r\n\t  keep   spaces  \n中文 🚀 <script>window.x=1</script>\n";
  const a = await mustUpload(originals.png.bytes, { name: "a.png" }), b = await mustUpload(originals.jpeg.bytes, { name: "b.jpg" }), c = await mustUpload(originals.webp.bytes, { name: "c.webp" });
  const created = await createWith({ content: text, attachmentIds: [c.id, a.id, b.id] });
  check("text with images is created", created.status === 201);
  check("exact text is preserved", created.data.content === text);
  check("attachments keep the requested order", created.data.attachments.map(item => item.id).join() === [c.id, a.id, b.id].join() && created.data.attachments.map(item => item.position).join() === "0,1,2");
  const fetched = await web(`/api/handoffs/${created.data.id}`);
  check("a read returns the same text and ordered manifest", fetched.data.content === text && fetched.data.attachments.map(item => item.filename).join() === "c.webp,a.png,b.jpg");
  const listed = (await web("/api/handoffs")).data.handoffs.find(row => row.id === created.data.id);
  check("the list carries metadata and never image bytes", listed.attachments.length === 3 && JSON.stringify(listed).length < 5000 && !/"data"|base64/.test(JSON.stringify(listed)));
  check("text-only handoffs return an empty attachment list", (await createWith({ content: "plain" })).data.attachments.length === 0);

  const solo = await mustUpload(png, { name: "solo.png" });
  const imageOnly = await createWith({ attachmentIds: [solo.id] });
  check("an image-only handoff is created with empty content", imageOnly.status === 201 && imageOnly.data.content === "" && imageOnly.data.attachments.length === 1);
  const blank = await mustUpload(png), blankExplicit = await createWith({ content: "", attachmentIds: [blank.id] });
  check("explicit empty content is also accepted with an image", blankExplicit.status === 201);
  check("empty content without images is rejected", (await createWith({ content: "" })).status === 400 && (await createWith({})).status === 400 && (await createWith({ content: "   " })).status === 400);
  check("text over 200,000 characters is still rejected", (await createWith({ content: "x".repeat(200_001), attachmentIds: [(await mustUpload(png)).id] })).status === 400);
  check("image-only handoffs have no text to export", (await web(`/api/handoffs/${imageOnly.data.id}/download`)).status === 409);

  const before = await handoffCount(owner);
  const loose = await mustUpload(png);
  const failures = [
    ["an unknown attachment id", { content: "x", attachmentIds: ["nope"] }, 404],
    ["another owner's attachment", { content: "x", attachmentIds: [(await mustUpload(png, { user: stranger })).id] }, 404],
    ["an attachment already bound elsewhere", { content: "x", attachmentIds: [a.id] }, 409],
    ["duplicate ids", { content: "x", attachmentIds: [loose.id, loose.id] }, 400],
    ["eleven ids", { content: "x", attachmentIds: Array.from({ length: 11 }, (_, i) => `id${i}`) }, 400],
    ["a non-array", { content: "x", attachmentIds: loose.id }, 400],
  ];
  for (const [name, body, status] of failures) check(`binding rejects ${name} with ${status}`, (await createWith(body)).status === status);
  const foreignAnswer = (await createWith({ content: "x", attachmentIds: [(await mustUpload(png, { user: stranger })).id] })).data.error;
  check("a foreign id and a missing id answer identically", foreignAnswer === (await createWith({ content: "x", attachmentIds: ["nope"] })).data.error);
  check("failed creations leave no handoff and the free upload stays unattached", await handoffCount(owner) === before && (await attachmentRows(owner)).find(row => row.id === loose.id).handoff_id === null);
  check("a good id mixed with a bad one attaches nothing", (await createWith({ content: "x", attachmentIds: [loose.id, "nope"] })).status === 404 && (await attachmentRows(owner)).find(row => row.id === loose.id).handoff_id === null);

  const old = await mustUpload(png);
  await sql(`UPDATE attachments SET created_at = ${Date.now() - 25 * 3_600_000} WHERE id = ${quote(old.id)}`);
  check("an upload older than 24 hours can no longer be attached", (await createWith({ content: "x", attachmentIds: [old.id] })).status === 409);
  await sql(`UPDATE attachments SET state = 'pending' WHERE id = ${quote(loose.id)}`);
  check("an upload that never finished cannot be attached", (await createWith({ content: "x", attachmentIds: [loose.id] })).status === 409);
  await sql(`UPDATE attachments SET state = 'ready' WHERE id = ${quote(loose.id)}`);

  // ---- idempotency ----------------------------------------------------------------------------------------------
  const i1 = await mustUpload(png), i2 = await mustUpload(originals.jpeg.bytes), requestKey = crypto.randomUUID();
  const body = { content: "retry me", attachmentIds: [i1.id, i2.id], requestKey };
  const beforeRetry = await handoffCount(owner), one = await createWith(body), two = await createWith(body);
  check("the same request key and images return the existing handoff", one.status === 201 && two.status === 201 && one.data.id === two.data.id && await handoffCount(owner) === beforeRetry + 1);
  check("a retry is not blocked by its own attached images", two.data.attachments.length === 2);
  check("a different image order under the same key conflicts", (await createWith({ ...body, attachmentIds: [i2.id, i1.id] })).status === 409);
  check("different text under the same key conflicts", (await createWith({ ...body, content: "changed" })).status === 409);
  check("dropping an image under the same key conflicts", (await createWith({ ...body, attachmentIds: [i1.id] })).status === 409);

  // ---- concurrency ----------------------------------------------------------------------------------------------
  const contested = await mustUpload(png);
  const racers = await Promise.all(Array.from({ length: 6 }, () => createWith({ content: "race", attachmentIds: [contested.id] })));
  check("six simultaneous creations bind one upload exactly once", racers.filter(r => r.status === 201).length === 1 && racers.filter(r => r.status === 409).length === 5);
  check("exactly one handoff references the contested upload", (await attachmentRows(owner)).filter(row => row.id === contested.id).length === 1 && (await sql(`SELECT COUNT(*) AS n FROM handoffs WHERE owner_id = ${quote(owner)} AND content = 'race'`))[0].n === 1);
  const sameKey = crypto.randomUUID(), twin = await mustUpload(png);
  const twins = await Promise.all(Array.from({ length: 4 }, () => createWith({ content: "twin", attachmentIds: [twin.id], requestKey: sameKey })));
  check("simultaneous retries with one request key converge on one handoff", twins.every(r => r.status === 201 && r.data.id === twins[0].data.id));
  check("totals are written with the handoff", (await sql(`SELECT attachment_count AS c, attachment_bytes AS b FROM handoffs WHERE id = ${quote(created.data.id)}`))[0].c === 3
    && (await sql(`SELECT attachment_bytes AS b FROM handoffs WHERE id = ${quote(created.data.id)}`))[0].b === originals.png.bytes.length + originals.jpeg.bytes.length + originals.webp.bytes.length);
  check("the bind guard leaves no rows behind", (await sql("SELECT COUNT(*) AS n FROM attachment_bind_guard"))[0].n === 0);

  // ---- ten images, retrieval --------------------------------------------------------------------------------------
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push(await mustUpload(await fromPixels({ format: ["png", "jpeg", "webp"][i % 3], width: 24, height: 24, pixel: (x, y) => [(i * 25 + x * 3) % 256, (y * 9 + i * 11) % 256, i * 20] }), { name: `ten-${i}.img` }));
  const tenHandoff = await createWith({ content: "ten", attachmentIds: ten.map(item => item.id) });
  check("ten images attach in order", tenHandoff.status === 201 && tenHandoff.data.attachments.map(item => item.id).join() === ten.map(item => item.id).join());
  check("an eleventh image is refused", (await createWith({ content: "eleven", attachmentIds: [...ten.map(item => item.id), (await mustUpload(png)).id] })).status === 400);

  const preview = await web(`/api/handoffs/${created.data.id}/attachments/${a.id}`);
  check("the preview route returns the original bytes", sha256(preview.bytes) === sha256(originals.png.bytes) && preview.headers.get("content-type") === "image/png");
  check("previews are private, unsniffed and sandboxed", preview.headers.get("cache-control") === "no-store" && preview.headers.get("x-content-type-options") === "nosniff"
    && /sandbox/.test(preview.headers.get("content-security-policy")) && /^inline;/.test(preview.headers.get("content-disposition")));
  const download = await web(`/api/handoffs/${created.data.id}/attachments/${a.id}?download=1`);
  check("the download route serves the original as an attachment", /^attachment;/.test(download.headers.get("content-disposition")) && /a\.png/.test(download.headers.get("content-disposition")) && sha256(download.bytes) === sha256(originals.png.bytes));
  check("anonymous and foreign readers cannot fetch an image", (await call(`/api/handoffs/${created.data.id}/attachments/${a.id}`)).status === 401
    && (await web(`/api/handoffs/${created.data.id}/attachments/${a.id}`, "GET", undefined, stranger)).status === 404);
  check("an image is only reachable through its own handoff", (await web(`/api/handoffs/${tenHandoff.data.id}/attachments/${a.id}`)).status === 404);
  check("a client-supplied owner changes nothing", (await web(`/api/handoffs/${created.data.id}/attachments/${a.id}?ownerId=${stranger}`)).status === 200);

  // ---- MCP -------------------------------------------------------------------------------------------------------
  const tools = (await rpc(null, null, bearer(token), "tools/list")).data.result.tools;
  check("exactly five tools remain", tools.length === 5 && tools.map(item => item.name).sort().join() === "claim_handoff,complete_handoff,create_handoff,get_handoff,list_handoffs");
  const createSchema = tools.find(item => item.name === "create_handoff").inputSchema, getSchema = tools.find(item => item.name === "get_handoff").inputSchema;
  check("create_handoff accepts ordered attachmentIds and no longer requires content", createSchema.properties.attachmentIds.maxItems === 10 && !createSchema.required.includes("content"));
  check("get_handoff accepts an optional attachmentId", !!getSchema.properties.attachmentId && getSchema.required.join() === "id");
  const m1 = await mustUpload(originals.png.bytes, { route: "/api/agent/attachments", auth: agentHeaders(), name: "m1.png" });
  const m2 = await mustUpload(originals.webp.bytes, { route: "/api/agent/attachments", auth: agentHeaders(), name: "m2.webp" });
  const viaMcp = toolJson(await rpc("create_handoff", { title: "MCP images", content: text, attachmentIds: [m2.id, m1.id], sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID() }));
  check("MCP create_handoff binds images and returns a summary with their count", viaMcp.attachmentCount === 2 && !("content" in viaMcp) && !("attachments" in viaMcp));
  const manifest = toolJson(await rpc("get_handoff", { id: viaMcp.id }));
  check("get_handoff returns the original text and the ordered manifest", manifest.content === text && manifest.attachments.map(item => item.id).join() === [m2.id, m1.id].join()
    && manifest.attachments[0].sha256 === sha256(originals.webp.bytes));
  const image = tool(await rpc("get_handoff", { id: viaMcp.id, attachmentId: m2.id }));
  check("get_handoff with attachmentId returns identifying text plus one image block", image.content.length === 2 && image.content[0].type === "text" && image.content[1].type === "image");
  check("the image block carries the original bytes and MIME type", image.content[1].mimeType === "image/webp" && sha256(Buffer.from(image.content[1].data, "base64")) === sha256(originals.webp.bytes));
  check("the image response does not repeat the prompt text", !image.content[0].text.includes("keep   spaces") && JSON.parse(image.content[0].text).attachment.id === m2.id);
  const sequential = [];
  for (const item of tenHandoff.data.attachments) sequential.push(tool(await rpc("get_handoff", { id: tenHandoff.data.id, attachmentId: item.id })).content[1]);
  check("ten images are retrieved one by one in order with matching hashes", sequential.length === 10 && sequential.every((block, i) => sha256(Buffer.from(block.data, "base64")) === ten[i].sha256));
  const claimed = await rpc("claim_handoff", { id: viaMcp.id, device: "Desktop", version: viaMcp.version });
  check("claim results contain metadata only", !new TextDecoder().decode(claimed.bytes).includes('"type":"image"') && JSON.stringify(claimed.data).length < 4000);
  const done = await rpc("complete_handoff", { id: viaMcp.id, version: toolJson(claimed).version });
  check("complete results contain metadata only", toolJson(done).status === "done" && toolJson(done).attachmentCount === 2 && !("attachments" in toolJson(done)));
  const mcpList = toolJson(await rpc("list_handoffs", {}));
  check("list_handoffs carries an image count but no manifest or bytes", mcpList.handoffs.some(row => row.id === tenHandoff.data.id && row.attachmentCount === 10)
    && mcpList.handoffs.every(row => !("attachments" in row)) && JSON.stringify(mcpList).length < 200_000 && !JSON.stringify(mcpList).includes('"data"'));
  check("a foreign Agent Token cannot read the image", (await rpc("get_handoff", { id: viaMcp.id, attachmentId: m2.id }, bearer(strangerToken))).data.result.isError === true);
  check("an image belongs only to its own handoff over MCP", (await rpc("get_handoff", { id: tenHandoff.data.id, attachmentId: m2.id })).data.result.isError === true);
  check("a bad attachmentId is a tool error", (await rpc("get_handoff", { id: viaMcp.id, attachmentId: 5 })).data.result.isError === true);
  check("MCP creation with a foreign upload is refused", (await rpc("create_handoff", { title: "x", content: "x", attachmentIds: [(await mustUpload(png, { user: stranger })).id], sourceDevice: "A", targetDevice: "B", requestKey: crypto.randomUUID() })).data.result.isError === true);

  // ---- expiry --------------------------------------------------------------------------------------------------
  const expiring = await createWith({ content: "soon gone", attachmentIds: [(await mustUpload(png, { name: "exp.png" })).id] });
  await sql(`UPDATE handoffs SET expires_at = 1 WHERE id = ${quote(expiring.data.id)}`);
  const expiredId = expiring.data.attachments[0].id;
  check("normal reads respect handoff expiry", (await web(`/api/handoffs/${expiring.data.id}/attachments/${expiredId}`)).status === 404 && (await web(`/api/handoffs/${expiring.data.id}`)).status === 404);
  check("MCP reads respect handoff expiry", (await rpc("get_handoff", { id: expiring.data.id, attachmentId: expiredId })).data.result.isError === true);
  check("another owner cannot use the Storage image route", (await web(`/api/storage/handoffs/${expiring.data.id}/attachments/${expiredId}`, "GET", undefined, stranger)).status === 404);
  // Measuring Storage deletes what is due, so from here on the expired handoff is gone everywhere, images included.
  await web("/api/storage");
  check("an expired handoff is deleted with its image rows", (await web(`/api/storage/handoffs/${expiring.data.id}`)).status === 404
    && (await web(`/api/storage/handoffs/${expiring.data.id}/attachments/${expiredId}`)).status === 404
    && (await sql(`SELECT COUNT(*) AS n FROM attachments WHERE id = ${quote(expiredId)}`))[0].n === 0);
  check("an expired handoff's image object is deleted from R2", (await r2Object(expiredId)) === null);

  // ---- Agent Token download route ------------------------------------------------------------------------------------
  const pull = (handoffId, attachmentId, auth = agentHeaders(), method = "GET") => call(`/api/agent/handoffs/${handoffId}/attachments/${attachmentId}`, { method, headers: auth });
  const pulled = await pull(created.data.id, a.id);
  check("an Agent Token downloads the exact original bytes", pulled.status === 200 && sha256(pulled.bytes) === sha256(originals.png.bytes) && pulled.headers.get("content-type") === "image/png" && pulled.bytes.length === originals.png.bytes.length);
  check("the download is never cached, sniffed or scriptable", pulled.headers.get("cache-control") === "no-store" && pulled.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(pulled.headers.get("content-security-policy") ?? ""));
  check("it never exposes the storage key", !/object|owner/i.test([...pulled.headers.keys()].join()) && !/a\/[0-9a-f-]{36}/.test([...pulled.headers.values()].join()));
  const sameBytesViaMcp = tool(await rpc("get_handoff", { id: created.data.id, attachmentId: b.id })).content[1];
  const sameBytesViaHttp = await pull(created.data.id, b.id);
  check("HTTP and MCP deliver the same bytes", sha256(Buffer.from(sameBytesViaMcp.data, "base64")) === sha256(sameBytesViaHttp.bytes));
  check("no credential is a 401", (await pull(created.data.id, a.id, {})).status === 401);
  check("a malformed Agent Token is a 401", (await pull(created.data.id, a.id, bearer("agentrelay_invalid"))).status === 401);
  check("platform sign-in alone does not open the Agent route", (await pull(created.data.id, a.id, identity(owner))).status === 401);
  const foreign = await pull(created.data.id, a.id, bearer(strangerToken)), absent = await pull(created.data.id, "does-not-exist");
  check("another workspace's token and an unknown id answer identically", foreign.status === 404 && absent.status === 404 && new TextDecoder().decode(foreign.bytes) === new TextDecoder().decode(absent.bytes));
  check("an image of another handoff is not reachable through this handoff", (await pull(imageOnly.data.id, a.id)).status === 404);
  check("an expired handoff's image is not downloadable", (await pull(expiring.data.id, expiredId)).status === 404);
  check("the route is read-only", [(await pull(created.data.id, a.id, agentHeaders(), "POST")).status, (await pull(created.data.id, a.id, agentHeaders(), "DELETE")).status].every(status => status === 405));
  const revocable = (await web("/api/agent-tokens", "POST", { name: "Short lived", expiresInDays: 1 })).data;
  check("a token works until it is revoked", (await pull(created.data.id, a.id, bearer(revocable.token))).status === 200);
  await web(`/api/agent-tokens/${revocable.id}`, "DELETE");
  check("a revoked token is refused", (await pull(created.data.id, a.id, bearer(revocable.token))).status === 401);

  // ---- deletion and cleanup --------------------------------------------------------------------------------------
  // ---- deletion and cleanup --------------------------------------------------------------------------------------
  const doomed = await createWith({ content: "doomed", attachmentIds: [(await mustUpload(png, { name: "d.png" })).id, (await mustUpload(originals.jpeg.bytes, { name: "d.jpg" })).id] });
  const doomedIds = doomed.data.attachments.map(item => item.id);
  const stale = await web("/api/storage/handoffs/delete", "POST", { items: [{ id: doomed.data.id, version: doomed.data.version + 7 }] });
  check("a stale deletion removes nothing", stale.data.results[0].status === "conflict" && (await attachmentRows(owner)).filter(row => doomedIds.includes(row.id)).length === 2 && (await sql("SELECT COUNT(*) AS n FROM object_cleanup WHERE owner_id = " + quote(owner)))[0].n === 0);
  const removed = await web("/api/storage/handoffs/delete", "POST", { items: [{ id: doomed.data.id, version: doomed.data.version }] });
  check("a version-checked deletion succeeds", removed.data.results[0].status === "deleted");
  check("attachment rows are gone and nothing is left queued", (await attachmentRows(owner)).filter(row => doomedIds.includes(row.id)).length === 0 && (await sql("SELECT COUNT(*) AS n FROM object_cleanup WHERE owner_id = " + quote(owner)))[0].n === 0);
  check("the deleted handoff's objects are gone from R2", (await Promise.all(doomedIds.map(id => r2Object(id)))).every(object => object === null));
  check("a deleted handoff's images are unreachable", (await web(`/api/handoffs/${doomed.data.id}/attachments/${doomedIds[0]}`)).status === 404);
  const legacyDelete = await createWith({ content: "legacy", attachmentIds: [(await mustUpload(png)).id] });
  check("the legacy DELETE route also releases images", (await web(`/api/handoffs/${legacyDelete.data.id}`, "DELETE")).status === 200 && (await attachmentRows(owner)).every(row => row.handoff_id !== legacyDelete.data.id));

  const orphan = await mustUpload(png, { name: "orphan.png" });
  await sql(`UPDATE attachments SET created_at = ${Date.now() - 25 * 3_600_000} WHERE id = ${quote(orphan.id)}`);
  const swept = await web("/api/storage/cleanup", "POST");
  check("cleanup reclaims stale unattached uploads", swept.status === 200 && swept.data.reclaimedUploads >= 1 && !(await attachmentRows(owner)).some(row => row.id === orphan.id));
  check("cleanup deletes the queued object and reports an empty queue", swept.data.pendingCleanup.count === 0 && typeof swept.data.unattached.count === "number" && await r2Object(orphan.id) === null);
  check("cleanup requires authentication and same-origin", (await call("/api/storage/cleanup", { method: "POST" })).status === 401 && (await web("/api/storage/cleanup", "POST", undefined, owner, { Origin: "https://untrusted.example" })).status === 403);
  const dangling = await mustUpload(png);
  await sql(`UPDATE attachments SET handoff_id = 'missing-handoff', position = 0 WHERE id = ${quote(dangling.id)}`);
  check("cleanup reclaims attachments whose handoff no longer exists (older code deleted them)", (await web("/api/storage/cleanup", "POST")).data.reclaimedUploads >= 1 && !(await attachmentRows(owner)).some(row => row.id === dangling.id) && await r2Object(dangling.id) === null);
  const foreignOld = await mustUpload(png, { user: stranger });
  await sql(`UPDATE attachments SET created_at = ${Date.now() - 25 * 3_600_000} WHERE id = ${quote(foreignOld.id)}`);
  await web("/api/storage/cleanup", "POST");
  check("one owner's cleanup never touches another owner's uploads", (await attachmentRows(stranger)).some(row => row.id === foreignOld.id));

  // ---- cleanup racing with creation: each upload ends up attached or reclaimed, never half of each --------------------
  let attachedCount = 0, reclaimedCount = 0;
  for (const offset of [600, 1000, 1400, 1800, 2200, 2800]) {
    const candidates = [];
    for (let i = 0; i < 4; i++) candidates.push(await mustUpload(png));
    // Each upload expires `offset` ms after this update starts, so creation and cleanup compete around the boundary.
    const expiry = Date.now() - 24 * 3_600_000 + offset;
    await sql(`UPDATE attachments SET created_at = ${expiry} WHERE id IN (${candidates.map(item => quote(item.id)).join(",")})`);
    const outcomes = await Promise.all([...candidates.map(item => createWith({ content: `boundary-${item.id}`, attachmentIds: [item.id] })), web("/api/storage/cleanup", "POST"), web("/api/storage/cleanup", "POST")]);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry + 24 * 3_600_000 - Date.now()) + 300));
    await web("/api/storage/cleanup", "POST");
    for (const [i, item] of candidates.entries()) {
      const row = (await attachmentRows(owner)).find(entry => entry.id === item.id), created = outcomes[i].status === 201;
      if (created) { attachedCount++; assert.ok(row && row.handoff_id === outcomes[i].data.id, `created handoff must own its image (${item.id})`); assert.ok(await r2Object(item.id), "an attached image must keep its object"); }
      else { reclaimedCount++; assert.ok([404, 409].includes(outcomes[i].status), `unexpected status ${outcomes[i].status}`); assert.ok(!row || row.handoff_id === null, "a failed creation must not leave a bound image"); }
    }
  }
  check(`boundary race kept every upload consistent (${attachedCount} attached, ${reclaimedCount} refused)`, attachedCount + reclaimedCount === 24);
  const everyBound = await sql(`SELECT a.id FROM attachments a LEFT JOIN handoffs h ON h.id = a.handoff_id WHERE a.owner_id = ${quote(owner)} AND a.handoff_id IS NOT NULL AND h.id IS NULL`);
  check("no attachment points at a missing handoff after the races", everyBound.length === 0);
  // ---- the local uploader command, end to end ---------------------------------------------------------------------------------
  const set = await buildVerificationSet();
  assertSetIsValid(set);
  const work = mkdtempSync(path.join(tmpdir(), "agentrelay-cli-"));
  const filePath = item => path.join(work, item.name);
  for (const item of set) writeFileSync(filePath(item), item.bytes);
  const cliEnv = (extra = {}) => ({ ...process.env, AGENTRELAY_MCP_URL: `${base}/api/agent/mcp`, AGENTRELAY_AGENT_TOKEN: token, AGENTRELAY_SITES_GATEWAY_TOKEN: "local-gateway-secret", ...extra });
  const uploader = async (args, env = cliEnv()) => spawnTest(process.execPath, ["scripts/agents/upload-attachments.mjs", ...args], { encoding: "utf8", env, windowsHide: true, timeout: 180_000 });
  const unattached = async () => (await sql(`SELECT COUNT(*) AS n FROM attachments WHERE owner_id = ${quote(owner)} AND handoff_id IS NULL`))[0].n;
  const named = name => set.find(item => item.name === name);
  try {
    const near = ["near-limit-png.png", "near-limit-jpeg.jpg", "near-limit-webp.webp"].map(named);
    const first = await uploader(near.map(filePath));
    check("the uploader succeeds for a near-limit image of each format", first.status === 0 && first.stderr === "");
    const printed = JSON.parse(first.stdout);
    check("it prints ordered attachment ids with exact metadata and a retry key", printed.attachmentIds.length === 3 && printed.attachments.every((info, i) => info.sha256 === sha256(near[i].bytes) && info.bytes === 1_048_576 && info.filename === near[i].name) && /^cli-/.test(printed.retryKey));
    check("it never prints a credential", !(first.stdout + first.stderr).includes(token) && !(first.stdout + first.stderr).includes("local-gateway-secret"));
    const again = await uploader(["--retry-key", "verify-retry", ...near.map(filePath)]), repeat = await uploader(["--retry-key", "verify-retry", ...near.map(filePath)]);
    check("a deliberate retry with the same retry key returns the same uploads", JSON.parse(again.stdout).attachmentIds.join() === JSON.parse(repeat.stdout).attachmentIds.join());
    const codex = await uploader(near.slice(0, 1).map(filePath), cliEnv({ AGENTRELAY_SITES_GATEWAY_TOKEN: "", AGENTRELAY_SITES_GATEWAY_HEADER: "Bearer codex-gateway-secret" }));
    check("the Codex gateway header variable is accepted instead of a bare token", codex.status === 0 && !codex.stdout.includes("codex-gateway-secret"));
    const nearHandoff = toolJson(await rpc("create_handoff", { title: "Near limit via CLI", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID(), attachmentIds: printed.attachmentIds }));
    const nearBlocks = [], nearManifest = toolJson(await rpc("get_handoff", { id: nearHandoff.id }));
    for (const info of nearManifest.attachments) nearBlocks.push(tool(await rpc("get_handoff", { id: nearHandoff.id, attachmentId: info.id })).content[1]);
    check("near-limit images of every format come back byte for byte as image blocks", nearManifest.content === "" && nearBlocks.every((block, i) => block.mimeType === ["image/png", "image/jpeg", "image/webp"][i] && sha256(Buffer.from(block.data, "base64")) === sha256(near[i].bytes)));
    const tenFiles = set.filter(item => item.name.startsWith("ten-"));
    const tenUpload = JSON.parse((await uploader(tenFiles.map(filePath))).stdout);
    check("ten images upload in one command, in order", tenUpload.attachmentIds.length === 10 && tenUpload.attachments.every((info, i) => info.filename === tenFiles[i].name));
    const tenViaCli = toolJson(await rpc("create_handoff", { title: "Ten via CLI", content: "ten", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID(), attachmentIds: tenUpload.attachmentIds }));
    const received = [];
    const tenManifest = toolJson(await rpc("get_handoff", { id: tenViaCli.id })).attachments;
    for (const info of tenManifest) received.push(tool(await rpc("get_handoff", { id: tenViaCli.id, attachmentId: info.id })).content[1]);
    check("a ten-image handoff is retrieved sequentially with every hash intact", received.length === 10 && received.every((block, i) => sha256(Buffer.from(block.data, "base64")) === sha256(tenFiles[i].bytes)));
    const edge = ["longest-edge-png.png", "max-pixels-jpeg.jpg", "max-pixels-webp.webp"].map(named);
    check("images at the edge and pixel limits upload through the command", (await uploader(edge.map(filePath))).status === 0);

    const downloader = async (args, env = cliEnv()) => spawnTest(process.execPath, ["scripts/agents/download-attachments.mjs", ...args], { encoding: "utf8", env, windowsHide: true, timeout: 180_000 });
    const out = path.join(work, "downloads");
    const fetched = await downloader(["--out", out, tenViaCli.id]);
    const printedFiles = JSON.parse(fetched.stdout);
    check("the downloader writes all ten images in manifest order", fetched.status === 0 && fetched.stderr === "" && printedFiles.files.length === 10
      && printedFiles.files.every((file, i) => file.position === i + 1 && path.basename(file.path).startsWith(String(i + 1).padStart(2, "0") + "-")));
    check("every downloaded file equals the image that was sent", printedFiles.files.every((file, i) => sha256(readFileSync(file.path)) === sha256(tenFiles[i].bytes) && file.attachmentId === tenManifest[i].id));
    check("the downloader never prints a credential", !(fetched.stdout + fetched.stderr).includes(token) && !(fetched.stdout + fetched.stderr).includes("local-gateway-secret"));
    check("a rerun keeps the files and prints the same paths", JSON.stringify(JSON.parse((await downloader(["--out", out, tenViaCli.id])).stdout)) === JSON.stringify(printedFiles));
    const nearDownload = JSON.parse((await downloader(["--out", path.join(work, "near"), nearHandoff.id])).stdout);
    check("near-limit images of every format download byte for byte", nearDownload.files.length === 3 && nearDownload.files.every((file, i) => file.bytes === 1_048_576 && sha256(readFileSync(file.path)) === sha256(near[i].bytes)));
    const wrongToken = await downloader(["--out", path.join(work, "denied"), tenViaCli.id], cliEnv({ AGENTRELAY_AGENT_TOKEN: strangerToken }));
    check("another workspace's token gets no images and no files", wrongToken.status !== 0 && wrongToken.stdout === "" && /no longer exists or has expired/.test(wrongToken.stderr) && !wrongToken.stderr.includes(strangerToken));
    check("a missing handoff id is a clear error", (await downloader([])).status !== 0 && (await downloader(["../x"])).stderr.includes("handoff id"));
    check("a handoff without images says so", /no images/.test((await downloader(["--out", path.join(work, "none"), (await createWith({ content: "plain" })).data.id])).stderr));

    const strays = await unattached();
    writeFileSync(path.join(work, "notes.txt"), "not an image");
    const rejected = await uploader([filePath(named("basic-png.png")), path.join(work, "notes.txt")]);
    check("one bad file stops the command before anything is uploaded", rejected.status !== 0 && rejected.stdout === "" && /notes\.txt/.test(rejected.stderr) && await unattached() === strays);
    check("a wrong Agent Token is reported without echoing it", (r => r.status !== 0 && /refused the credentials \(401\)/.test(r.stderr) && !r.stderr.includes(`agentrelay_${"0".repeat(64)}`))(await uploader([filePath(named("basic-png.png"))], cliEnv({ AGENTRELAY_AGENT_TOKEN: `agentrelay_${"0".repeat(64)}` }))));
    check("more than ten files are refused locally", (await uploader(Array.from({ length: 11 }, () => filePath(named("basic-png.png"))))).stderr.includes("at most 10"));
  } finally { rmSync(work, { recursive: true, force: true }); }

  // ---- Storage accounting: text plus image bytes -----------------------------------------------------------------------
  const storageOwner = `${owner}-storage`;
  const bigImage = padTo(await flat({ format: "png", width: 64, height: 64, color: { r: 30, g: 60, b: 90 } }), "png", 200_000);
  const heavy = await createWith({ attachmentIds: [(await mustUpload(bigImage, { user: storageOwner })).id, (await mustUpload(bigImage, { user: storageOwner, key: crypto.randomUUID() })).id], project: "Sizes" }, storageOwner);
  const textual = await createWith({ content: "t".repeat(50_000), project: "Sizes" }, storageOwner);
  const mixed = await createWith({ content: "m".repeat(1000), attachmentIds: [(await mustUpload(png, { user: storageOwner })).id], project: "Sizes" }, storageOwner);
  check("storage test handoffs were created", [heavy, textual, mixed].every(item => item.status === 201));
  const storageList = (await web("/api/storage/handoffs?project=Sizes", "GET", undefined, storageOwner)).data;
  const byId = Object.fromEntries(storageList.handoffs.map(row => [row.id, row]));
  check("each row reports text, image and logical bytes", byId[heavy.data.id].promptBytes === 0 && byId[heavy.data.id].imageBytes === 400_000 && byId[heavy.data.id].logicalBytes === 400_000 && byId[heavy.data.id].attachmentCount === 2);
  check("a text-only row's logical size equals its prompt size", byId[textual.data.id].logicalBytes === 50_000 && byId[textual.data.id].imageBytes === 0 && byId[textual.data.id].attachmentCount === 0);
  check("a mixed row adds the two", byId[mixed.data.id].logicalBytes === 1000 + png.length && byId[mixed.data.id].promptBytes === 1000);
  check("largest-first orders by text plus images, so an image-only handoff leads", storageList.handoffs.map(row => row.id).join() === [heavy.data.id, textual.data.id, mixed.data.id].join());
  const smallest = (await web("/api/storage/handoffs?project=Sizes&sort=smallest", "GET", undefined, storageOwner)).data;
  check("smallest-first reverses it", smallest.handoffs.map(row => row.id).join() === [mixed.data.id, textual.data.id, heavy.data.id].join());
  const minimum = (await web("/api/storage/handoffs?project=Sizes&minBytes=100000", "GET", undefined, storageOwner)).data;
  check("the minimum-size filter counts image bytes", minimum.handoffs.length === 1 && minimum.handoffs[0].id === heavy.data.id && minimum.totalCount === 1);
  const summary = (await web("/api/storage", "GET", undefined, storageOwner)).data;
  check("the summary adds image counts, image bytes and logical totals", summary.handoffs.imageCount === 3 && summary.handoffs.imageBytes === 400_000 + png.length
    && summary.handoffs.promptBytes === 51_000 && summary.handoffs.logicalBytes === 451_000 + png.length && summary.groups.ready.logicalBytes === summary.handoffs.logicalBytes);
  check("image storage is reported apart from the database figures", summary.imageStorage.unattached.count === 0 && summary.imageStorage.pendingCleanup.count === 0 && summary.databaseBytes > 0 && summary.limitBytes === 10_000_000_000);
  await sql(`UPDATE handoffs SET expires_at = 1 WHERE id = ${quote(heavy.data.id)}`);
  const expiredSummary = (await web("/api/storage", "GET", undefined, storageOwner)).data;
  check("an expired handoff's images leave the totals when Storage deletes it", expiredSummary.groups.expired.count === 0 && expiredSummary.handoffs.imageCount === 1
    && expiredSummary.handoffs.imageBytes === png.length && expiredSummary.imageStorage.pendingCleanup.count === 0);
  const strayUpload = await mustUpload(png, { user: storageOwner });
  check("an unattached upload is counted separately", (await web("/api/storage", "GET", undefined, storageOwner)).data.imageStorage.unattached.count === 1 && !!strayUpload.id);
  const staleCursor = encodeURIComponent(JSON.stringify({ value: 1, id: "x", asOf: Date.now() - 1000, filters: JSON.stringify({}) }));
  check("a cursor from before image accounting is refused", (await web(`/api/storage/handoffs?cursor=${staleCursor}`, "GET", undefined, storageOwner)).status === 400);
  const many = [];
  for (let i = 0; i < 52; i += 8) many.push(...await Promise.all(Array.from({ length: Math.min(8, 52 - i) }, async (_, j) => {
    const picture = await fromPixels({ format: "png", width: 8, height: 8, pixel: () => [i + j, 7, 7] });
    return createWith({ content: `row ${i + j}`, project: "Paged", attachmentIds: [(await mustUpload(picture, { user: storageOwner })).id] }, storageOwner);
  })));
  check("52 handoffs with one image each were created", many.every(item => item.status === 201));
  const seen = new Set(); let cursor = null, pages = 0;
  do {
    const page = (await web(`/api/storage/handoffs?project=Paged&sort=largest${cursor ? `&cursor=${cursor}` : ""}`, "GET", undefined, storageOwner)).data;
    for (const row of page.handoffs) { assert.ok(!seen.has(row.id), "a row repeated across pages"); seen.add(row.id); }
    cursor = page.nextCursor; pages++;
  } while (cursor);
  check("paging by text plus image bytes visits every row exactly once", seen.size === 52 && pages === 2);
  const doomedPage = (await web("/api/storage/handoffs?project=Paged", "GET", undefined, storageOwner)).data.handoffs.slice(0, 5);
  const removedMany = await web("/api/storage/handoffs/delete", "POST", { items: doomedPage.map(row => ({ id: row.id, version: row.version })) }, storageOwner);
  check("a multi-item deletion releases every item's images", removedMany.data.deletedCount === 5 && (await sql(`SELECT COUNT(*) AS n FROM attachments WHERE owner_id = ${quote(storageOwner)} AND handoff_id IN (${doomedPage.map(row => quote(row.id)).join(",")})`))[0].n === 0 && (await sql(`SELECT COUNT(*) AS n FROM object_cleanup WHERE owner_id = ${quote(storageOwner)}`))[0].n === 0);
  console.log(JSON.stringify({ passed: passed.length }));
} finally {
  // Disposable owners only: remove their rows so repeated runs stay small. Objects are removed through the service's own cleanup.
  for (const user of [owner, stranger, `${owner}-storage`]) {
    try {
      await sql(`UPDATE attachments SET handoff_id = NULL, created_at = 1 WHERE owner_id = ${quote(user)}`);
      await web("/api/storage/cleanup", "POST", undefined, user).catch(() => undefined);
      await sql([`DELETE FROM handoffs WHERE owner_id = ${quote(user)}`, `DELETE FROM agent_tokens WHERE owner_id = ${quote(user)}`, `DELETE FROM devices WHERE owner_id = ${quote(user)}`]);
    } catch { /* best effort */ }
  }
}
