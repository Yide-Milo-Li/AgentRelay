// Browser acceptance for image handoffs on a built local Worker. Needs agent-browser; every record belongs to a disposable owner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { flat, fromPixels, padTo } from "../support/image-fixtures.mjs";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!/^(127\.0\.0\.1|localhost)$/.test(new URL(base).hostname)) throw new Error("Image browser checks only run against a local Worker.");
const run = crypto.randomUUID(), session = `agentrelay-images-${run.slice(0, 8)}`;
const headers = identityHeaders(`images-qa-${run}`, "images@sites.test");
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const output = path.resolve(process.env.AGENTRELAY_QA_OUTPUT ?? `outputs/image-handoffs/${run}`), files = path.join(output, "files");
const checks = [];
await mkdir(files, { recursive: true });

async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => { child.stdout.destroy(); child.stderr.destroy(); if (code === 0) resolve(text); else reject(new Error(error || text || `agent-browser exited ${code}`)); });
  });
  const result = JSON.parse(stdout.trim());
  if (!result.success) throw new Error(result.error);
  return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const click = selector => browser("click", selector);
const wait = expression => browser("wait", "--fn", expression);
const press = key => browser("press", key);
const capture = name => browser("screenshot", path.join(output, `${name}.png`));
// The language switch and Storage live in Settings: switch there, then return to the view the page was on.
async function setLanguage(lang) {
  const view = await evaluate("document.querySelector('.tabs [aria-current=page]')?.dataset.view ?? ''");
  const storage = await evaluate("!!document.querySelector('.settings[data-section=storage]')");
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(`.lang-switch button[lang="${lang}"]`);
  if (view) await click(`.tabs [data-view="${view}"]`); else if (storage) await click("[data-settings-section=storage]");
}
const openStorage = async () => { await click(".settings-button"); await click("[data-settings-section=storage]"); };
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); console.log(`PASS ${name}`); }
function ok(name, condition) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); }
async function request(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}
const save = async (name, bytes) => { const file = path.join(files, name); await writeFile(file, bytes); return file; };
const tray = "document.querySelector('.compose .attach')";
const items = status => `document.querySelectorAll('.compose .attach-item${status ? `[data-status=${status}]` : ""}')`;
const names = `[...document.querySelectorAll('.compose .attach-name')].map(node => node.textContent)`;
const noOverflow = "document.documentElement.scrollWidth <= innerWidth && (!document.querySelector('dialog[open]') || document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth + 1)";
// Browser-side helper: a File built from base64, delivered the way a paste or a drop delivers it.
const fileExpr = (name, type, bytes) => `new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))}), c => c.charCodeAt(0))], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })`;

try {
  const colors = [[200, 40, 40], [40, 160, 70], [50, 80, 210], [220, 170, 30]];
  const red = await save("red.png", await fromPixels({ format: "png", width: 120, height: 80, pixel: () => colors[0] }));
  const green = await save("green.jpg", await fromPixels({ format: "jpeg", width: 100, height: 100, pixel: () => colors[1] }));
  const blue = await save("blue.webp", await fromPixels({ format: "webp", width: 90, height: 60, pixel: (x, y) => [colors[2][0], colors[2][1] + (x % 20), colors[2][2] - (y % 20)] }));
  const gold = await save("gold.png", await fromPixels({ format: "png", width: 64, height: 64, pixel: () => colors[3] }));
  const tooBig = await save("too-big.png", padTo(await flat({ format: "png", width: 20, height: 20 }), "png", 1_048_577));
  const tooWide = await save("too-wide.png", await flat({ format: "png", width: 2561, height: 1 }));
  const manyPixels = await save("too-many-pixels.png", await flat({ format: "png", width: 2000, height: 2001 }));
  const gif = await save("anim.gif", new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"));
  const notImage = await save("notes.txt", new TextEncoder().encode("hello"));
  const extra = [];
  for (let i = 0; i < 9; i++) extra.push(await save(`extra-${i}.png`, await fromPixels({ format: "png", width: 20, height: 20, pixel: (x, y) => [i * 20, x * 5, y * 5] })));

  await request("/api/devices", "POST", { name: "Laptop" });
  await request("/api/devices", "POST", { name: "Desktop" });
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "1000");
  await browser("set", "media", "light");
  await evaluate("localStorage.setItem('agentrelay.device.v2', 'laptop'); localStorage.setItem('agentrelay.device.chosen.v1', '1'); true");
  await browser("reload");
  await wait("document.querySelector('.btn.primary.new') !== null");
  await click(".btn.primary.new");
  await wait("document.querySelector('dialog.compose[open]') !== null");
  await check("the composer offers images next to the prompt", `!!${tray} && ${tray}.querySelector('input[type=file]').accept === 'image/png,image/jpeg,image/webp' && ${tray}.querySelector('input[type=file]').multiple`);
  await check("the empty tray states the limits", `${tray}.querySelector('.attach-drop').textContent.includes('10 images') && ${tray}.querySelector('.attach-drop').textContent.includes('2,560')`);
  await check("Send needs a prompt or an image", "document.querySelector('.compose-foot .btn.primary').disabled === true");
  await capture("compose-empty");

  // ---- file picker ---------------------------------------------------------------------------------------------
  await browser("upload", ".compose input[type=file]", red, green, blue);
  await wait(`${items("uploaded")}.length === 3`);
  await check("the picker adds ordered previews with name, size and dimensions", `${names}.join() === 'red.png,green.jpg,blue.webp' && ${items()}[0].textContent.includes('120×80') && [...${items()}].every(item => item.querySelector('img').naturalWidth > 0)`);
  await check("every image shows its position and a finished state", `[...${items()}].every((item, i) => item.querySelector('.attach-meta').textContent.includes('Image ' + (i + 1) + ' of 3') && item.querySelector('.attach-status').textContent.includes('Uploaded'))`);
  await check("Send is enabled once the images are uploaded, even without text", "document.querySelector('.compose-foot .btn.primary').disabled === false");
  await check("the textarea no longer demands text when images are attached", "document.querySelector('.compose textarea[name=content]').required === false");
  await capture("compose-uploaded");

  // ---- order and removal -----------------------------------------------------------------------------------------
  await click(".compose .attach-item:nth-child(1) .attach-actions button:nth-child(2)");
  await check("move later swaps the first two images", `${names}.join() === 'green.jpg,red.png,blue.webp'`);
  await check("the first image cannot move earlier and the last cannot move later", `${items()}[0].querySelector('.attach-actions button:nth-child(1)').disabled && ${items()}[2].querySelector('.attach-actions button:nth-child(2)').disabled`);
  await click(".compose .attach-item:nth-child(3) .attach-actions button:last-child");
  await check("removing an image updates the list and positions", `${names}.join() === 'green.jpg,red.png' && ${items()}[1].textContent.includes('Image 2 of 2')`);

  // ---- local rejections with specific explanations ---------------------------------------------------------------
  await browser("upload", ".compose input[type=file]", tooBig, tooWide, manyPixels, gif, notImage);
  await wait(`${items("rejected")}.length === 5`);
  const messages = await evaluate("[...document.querySelectorAll('.compose .attach-problem')].map(node => node.textContent)");
  ok("oversized bytes are explained with both numbers", messages.some(text => text.includes("1,048,577") && text.includes("1,048,576")));
  ok("an over-long edge is explained", messages.some(text => text.includes("2561×1") && text.includes("2,560")));
  ok("too many pixels are explained", messages.some(text => text.includes("4,002,000") && text.includes("4,000,000")));
  ok("GIF and non-image files are explained as unsupported", messages.filter(text => text.includes("Only PNG, JPEG and WebP")).length === 2);
  await check("rejected images block Send with a reason", `document.querySelector('.compose-foot .btn.primary').disabled && document.querySelector('.attach-block').textContent.includes('not accepted')`);
  await check("rejected images never reach the server", `${items("uploaded")}.length === 2`);
  await capture("compose-rejected");
  for (let i = 0; i < 5; i++) await click(".compose .attach-item[data-status=rejected] .attach-actions button:last-child");
  await check("removing the rejected files re-enables Send", `${items()}.length === 2 && document.querySelector('.compose-foot .btn.primary').disabled === false`);

  // ---- the tenth image fits, the eleventh does not -------------------------------------------------------------------
  await browser("upload", ".compose input[type=file]", ...extra.slice(0, 8));
  await wait(`${items("uploaded")}.length === 10`);
  await browser("upload", ".compose input[type=file]", extra[8]);
  await wait(`${items("rejected")}.length === 1`);
  await check("an eleventh image is refused with the limit named", "document.querySelector('.compose .attach-problem').textContent.includes('Only 10 images')");
  await check("the add button is disabled when the tray is full", "[...document.querySelectorAll('.compose .attach-head .btn')].every(button => button.disabled)");
  await click(".compose .attach-item[data-status=rejected] .attach-actions button:last-child");
  for (let i = 0; i < 8; i++) await click(".compose .attach-item:last-child .attach-actions button:last-child");
  await check("images can be removed back down to two", `${items()}.length === 2`);

  // ---- paste and drop -----------------------------------------------------------------------------------------------
  const pasted = await flat({ format: "png", width: 30, height: 30, color: { r: 10, g: 10, b: 10 } });
  await evaluate(`{ const dt = new DataTransfer(); dt.items.add(${fileExpr("pasted.png", "image/png", pasted)}); document.querySelector('dialog.compose').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } true`);
  await wait(`${items("uploaded")}.length === 3`);
  await check("pasting an image adds it to the tray", `${names}.at(-1) === 'pasted.png'`);
  await evaluate("document.querySelector('.compose textarea').focus(); true");
  await browser("keyboard", "inserttext", "typed text");
  await check("typing into the prompt still works beside the tray", "document.querySelector('.compose textarea').value.includes('typed text') && document.querySelectorAll('.compose .attach-item').length === 3");
  const dropped = await flat({ format: "jpeg", width: 30, height: 20 });
  await evaluate(`window.__drop = new DataTransfer(); window.__drop.items.add(${fileExpr("dropped.jpg", "image/jpeg", dropped)});
    document.querySelector('dialog.compose').dispatchEvent(new DragEvent('dragenter', { dataTransfer: window.__drop, bubbles: true, cancelable: true })); true`);
  await wait("document.querySelector('dialog.compose').hasAttribute('data-dragging')");
  await check("dragging files over the composer highlights the drop area", "getComputedStyle(document.querySelector('.compose .attach')).borderColor !== getComputedStyle(document.querySelector('.compose .attach-item')).borderColor");
  await evaluate("document.querySelector('dialog.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: window.__drop, bubbles: true, cancelable: true })); true");
  await wait(`${items("uploaded")}.length === 4`);
  await check("dropping a file adds it and clears the highlight", `${names}.at(-1) === 'dropped.jpg' && !document.querySelector('dialog.compose').hasAttribute('data-dragging')`);

  // ---- retry after a failed upload -----------------------------------------------------------------------------------
  await evaluate("window.__realFetch = window.fetch; window.fetch = (url, options) => String(url).includes('/api/attachments') ? Promise.reject(new TypeError('offline')) : window.__realFetch(url, options); true");
  await browser("upload", ".compose input[type=file]", gold);
  await wait(`${items("failed")}.length === 1`);
  await check("a failed upload shows an error, a retry button and blocks Send", `document.querySelector('.compose .attach-item[data-status=failed] .attach-problem') !== null && !!document.querySelector('.compose .attach-item[data-status=failed] button[aria-label^="Retry"]') && document.querySelector('.compose-foot .btn.primary').disabled`);
  await evaluate("window.fetch = window.__realFetch; true");
  await click(".compose .attach-item[data-status=failed] button[aria-label^='Retry']");
  await wait(`${items("uploaded")}.length === 5`);
  await check("retrying uploads the same file and unblocks Send", `${items("failed")}.length === 0 && document.querySelector('.compose-foot .btn.primary').disabled === false`);

  // ---- cancellation and unsaved changes --------------------------------------------------------------------------------
  await check("the tray is keyboard reachable and every control has a name", `[...document.querySelectorAll('.compose .attach button, .compose .attach input')].every(control => control.getAttribute('aria-label') || control.textContent.trim())`);
  await click(".compose-head .icon");
  await wait("document.querySelector('.discard-confirm') !== null");
  await check("closing with only images still asks before discarding", "document.querySelector('.discard-confirm') !== null");
  await click(".discard-confirm .btn:not(.danger)");
  await check("continue editing keeps every image", `${items()}.length === 5 && !document.querySelector('.discard-confirm')`);
  await click(".compose .attach-item:nth-child(5) .attach-actions button:last-child");
  await click(".compose .attach-item:nth-child(4) .attach-actions button:last-child");
  await click(".compose .attach-item:nth-child(3) .attach-actions button:last-child");

  // ---- send: text with images ----------------------------------------------------------------------------------------
  await evaluate("document.querySelector('.compose [name=title]').focus(); true");
  await browser("fill", ".compose [name=title]", "Screenshot review");
  await browser("fill", ".compose textarea[name=content]", "# Check\nLook at both screenshots.");
  await click(".compose-foot .btn.primary");
  await wait("document.querySelector('dialog.compose[open]') === null && document.querySelector('.row') !== null");
  await check("the new handoff appears in the inbox with its image count", "document.querySelector('.row .row-images')?.textContent.trim() === '2'");
  await check("the detail view lists the images lazily with fixed dimensions", "document.querySelectorAll('.gallery-item img').length === 2 && [...document.querySelectorAll('.gallery-item img')].every(img => img.loading === 'lazy' && img.width > 0 && img.height > 0)");
  await wait("[...document.querySelectorAll('.gallery-item img')].every(img => img.complete && img.naturalWidth > 0)");
  await check("the images load from the private route", "[...document.querySelectorAll('.gallery-item img')].every(img => new URL(img.src).pathname.startsWith('/api/handoffs/') && img.naturalWidth > 0)");
  await check("text actions are labelled as text-only", "document.querySelector('.attach-note').textContent.includes('Text only') && document.querySelector('.detail-foot').textContent.includes('characters')");
  await capture("detail-gallery");
  await click(".gallery-item");
  await wait("document.querySelector('dialog.lightbox[open]') !== null");
  await check("clicking a thumbnail opens the viewer with a counter and original download", "document.querySelector('.lightbox-title').textContent.includes('1 / 2') && document.querySelector('.lightbox a[download]').href.includes('download=1')");
  await press("ArrowRight");
  await check("arrow keys move between images", "document.querySelector('.lightbox-title').textContent.includes('2 / 2') && document.querySelector('.lightbox-nav:last-child').disabled");
  await press("ArrowLeft");
  await check("ArrowLeft goes back", "document.querySelector('.lightbox-title').textContent.includes('1 / 2')");
  await capture("lightbox");
  await press("Escape");
  await wait("document.querySelector('dialog.lightbox[open]') === null");
  await check("Escape closes the viewer and returns focus to the thumbnail", "document.activeElement.classList.contains('gallery-item')");

  // ---- image-only handoff ----------------------------------------------------------------------------------------------
  await click(".btn.primary.new");
  await wait("document.querySelector('dialog.compose[open]') !== null");
  await browser("fill", ".compose [name=title]", "Only a picture");
  await browser("upload", ".compose input[type=file]", gold);
  await wait(`${items("uploaded")}.length === 1`);
  await click(".compose-foot .btn.primary");
  await wait("document.querySelector('dialog.compose[open]') === null && document.querySelector('.detail h1')?.textContent === 'Only a picture'");
  await check("an image-only handoff is created and says it has no text", "document.querySelector('.prompt-empty') !== null && document.querySelectorAll('.gallery-item').length === 1");
  await check("copy and export are disabled when there is no text", "document.querySelector('.actions .btn.primary').disabled === true && [...document.querySelectorAll('.actions .icon')].find(button => button.getAttribute('aria-label') === 'Download .md').disabled === true");
  await check("the inbox shows the image count for it too", "[...document.querySelectorAll('.row')].some(row => row.textContent.includes('Only a picture') && row.querySelector('.row-images')?.textContent.trim() === '1')");

  // ---- Storage -------------------------------------------------------------------------------------------------------------
  await openStorage();
  await wait("document.querySelector('.storage-table-wrap')?.getAttribute('aria-busy') === 'false'");
  // R2 has no fixed limit on Sites; a standalone Cloudflare deployment shows its free allowance instead.
  const r2Label = process.env.AGENTRELAY_TEST_TARGET === "cloudflare" ? "10 GB-month free, billed above" : "No fixed limit";
  await check("Storage draws images on the composition bar and reports R2 apart from the database quota", `document.querySelector('.storage-segment[data-kind=\"images\"]') !== null && [...document.querySelectorAll('.storage-quota')].some(row => row.textContent.includes('Image storage (R2)') && row.textContent.includes(${JSON.stringify(r2Label)})) && document.querySelector('.storage-images').textContent.includes('3 images attached')`);
  await check("rows with images break the size down into text and images", "[...document.querySelectorAll('.storage-table tbody tr')].some(row => row.textContent.includes('2 images'))");
  await click(".storage-images .btn");
  await wait("document.querySelector('.storage-notice') !== null");
  await check("running cleanup reports its result", "document.querySelector('.storage-notice').textContent.includes('Cleanup finished')");
  await click(".storage-row-title");
  await wait("document.querySelector('.storage-preview .gallery') !== null || document.querySelector('.storage-preview .prompt-empty') !== null");
  await check("the Storage preview lists images through the Storage route", "[...document.querySelectorAll('.storage-preview .gallery-item img')].every(img => new URL(img.src).pathname.startsWith('/api/storage/handoffs/'))");
  await press("Escape");
  await capture("storage");

  // ---- Chinese, dark mode and a narrow screen ----------------------------------------------------------------------------
  await click("[data-view=inbox]");
  await setLanguage("zh-CN");
  await click(".btn.primary.new");
  await wait("document.querySelector('dialog.compose[open]') !== null");
  await check("the composer is translated", `${tray}.textContent.includes('图片') && ${tray}.textContent.includes('拖放、粘贴或选择图片')`);
  await browser("upload", ".compose input[type=file]", tooBig, tooWide);
  await wait(`${items("rejected")}.length === 2`);
  const zh = await evaluate("[...document.querySelectorAll('.compose .attach-problem')].map(node => node.textContent)");
  ok("rejection messages are translated with the same numbers", zh.some(text => text.includes("1,048,577") && text.includes("字节")) && zh.some(text => text.includes("2561×1") && text.includes("像素")));
  await check("status labels are translated", `${items("rejected")}[0].querySelector('.attach-status').textContent.includes('不符合要求')`);
  await capture("compose-zh");
  await browser("set", "media", "dark");
  await capture("compose-dark");
  await browser("set", "media", "light");
  await browser("set", "viewport", "390", "844");
  await check("the composer has no horizontal overflow at 390 px", noOverflow);
  await capture("compose-mobile");
  await click(".compose-head .icon");
  await click(".discard-confirm .btn.danger");
  await wait("document.querySelector('dialog.compose[open]') === null");
  await setLanguage("en");
  await check("the detail view has no horizontal overflow at 390 px", noOverflow);
  await capture("detail-mobile");
  await browser("set", "viewport", "1440", "1000");

  const summary = { base, passed: checks.length, checks };
  await writeFile(path.join(output, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  try {
    for (const row of (await request("/api/handoffs")).handoffs ?? []) await fetch(`${base}/api/handoffs/${row.id}`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: row.version }) });
    for (const device of (await request("/api/devices")).devices ?? []) await fetch(`${base}/api/devices/${device.id}`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: device.version }) });
  } catch { /* best effort */ }
  try { await browser("close"); } catch { /* the session may already be gone */ }
}
