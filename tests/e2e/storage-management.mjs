// Browser acceptance uses a disposable owner on the built local Worker, never a live Site.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Storage browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `storage-browser-${run}`, session = `storage-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/storage-e2e/${run}`), headers = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": "storage@sites.test" };
const localState = process.env.AGENTRELAY_TEST_STATE ?? ".wrangler/state";
const localConfig = process.env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json";
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const checks = [], prompt = "# Stored prompt 中文 🚀\r\n\t  preserve spaces  \n<script>window.__storageExecuted = true</script>\n".repeat(30);
await mkdir(output, { recursive: true });

async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => { child.stdout.destroy(); child.stderr.destroy(); if (code === 0) resolve(text); else reject(new Error(error || text)); });
  });
  const result = JSON.parse(stdout.trim()); if (!result.success) throw new Error(result.error); return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const click = selector => browser("click", selector);
const wait = expression => browser("wait", "--fn", expression);
const loaded = () => wait("document.querySelector('.storage-table-wrap')?.getAttribute('aria-busy') === 'false'");
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
async function request(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
}
const reset = async () => { await click(".storage-presets .link"); await loaded(); };

try {
  const created = [];
  // 53 handoffs, one of which expires before Storage opens: the 52 that remain fill one page and two rows of the next.
  for (let offset = 0; offset < 53; offset += 8) {
    created.push(...await Promise.all(Array.from({ length: Math.min(8, 53 - offset) }, (_, step) => {
      const index = offset + step;
      const title = index === 0 ? "Prompt to inspect" : index === 52 ? "Expires before Storage opens" : `Storage row ${index}`;
      return request("/api/handoffs", "POST", { title, content: index === 0 ? prompt : `Prompt ${index} 中文`,
        project: "Storage browser", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID() });
    })));
  }
  const inspected = created.find(row => row.title === "Prompt to inspect"), expired = created.find(row => row.title === "Expires before Storage opens");
  execFileSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", localConfig, "--persist-to", localState, "--command",
    `UPDATE handoffs SET expires_at = 1 WHERE owner_id = '${owner}' AND id = '${expired.id}';`], { stdio: "pipe", windowsHide: true });
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "1000");
  await browser("set", "media", "light");
  await wait("document.querySelector('.settings-button') !== null");
  await openStorage(); await loaded();
  await check("checkboxes have inset spacing and rounded corners", "parseFloat(getComputedStyle(document.querySelector('.storage-check')).paddingLeft) >= 10 && parseFloat(getComputedStyle(document.querySelector('.storage-check input')).borderRadius) >= 4");
  await check("Storage uses the same entrance animation as the other management tabs", "getComputedStyle(document.querySelector('.storage-view')).animationName === 'settle' && getComputedStyle(document.querySelector('.storage-view')).animationDuration === '0.55s'");
  await check("Storage page identity, content and no framework overlay", "document.title.includes('AgentRelay') && location.origin === " + JSON.stringify(base) + " && document.querySelector('#storage-title').textContent === 'Storage' && !document.querySelector('vite-error-overlay')");
  assert.equal((await fetch(`${base}/api/storage/handoffs/${expired.id}`, { headers })).status, 404, "an expired handoff is deleted before Storage lists it");
  checks.push("an expired handoff is deleted before Storage lists it");
  await check("Storage says expired handoffs are deleted automatically and offers no Expired shortcut", "document.querySelector('.storage-manager-heading p').textContent.includes('deleted automatically') && !document.querySelector('.storage-presets').textContent.includes('Expired')");
  await check("the image cleanup button names what it cleans", "document.querySelector('.storage-images .btn').textContent === 'Clean up images'");
  await check("initial page has 50 rows and no automatic selection", "document.querySelectorAll('.storage-table tbody tr').length === 50 && document.querySelectorAll('.storage-table input:checked').length === 0 && !document.querySelector('.storage-selection')");
  await capture("desktop-default");
  await browser("set", "media", "dark"); await capture("desktop-dark");
  await browser("set", "media", "light");
  await click(".storage-row-title");
  await wait("document.querySelector('.storage-preview .prompt-markdown') !== null");
  // The preview renders Markdown, so raw HTML must surface as inert text; exact storage is checked on the API record.
  await check("preview renders Markdown and shows raw HTML as inert text", "document.querySelectorAll('.storage-preview .prompt-markdown h1').length === 30 && [...document.querySelectorAll('.storage-preview .prompt-markdown pre')].every(pre => pre.textContent === '  preserve spaces  \\n') && document.querySelector('.storage-preview .prompt-markdown').textContent.includes('<script>window.__storageExecuted = true</script>') && !window.__storageExecuted && !document.querySelector('.storage-preview script')");
  assert.equal((await request(`/api/storage/handoffs/${inspected.id}`)).content, prompt);
  checks.push("the stored record keeps its exact prompt text");
  await browser("press", "Escape");
  await check("preview Escape restores its opener", "!document.querySelector('dialog[open]') && document.activeElement.matches('.storage-row-title')");
  await click("thead input[type=checkbox]");
  await check("select-page selects at most 50 reviewed records", "document.querySelectorAll('.storage-table tbody input:checked').length === 50 && document.querySelector('.storage-selection strong').textContent === '50 selected'");
  await capture("desktop-selected");
  await browser("select", ".storage-primary-filters label:nth-child(4) select", "oldest"); await loaded();
  await check("changing sort clears selection", "!document.querySelector('.storage-selection') && document.querySelectorAll('.storage-table input:checked').length === 0");
  await click(".storage-table tbody input");
  await browser("fill", ".storage-search input", "Storage row 1"); await loaded();
  await check("changing search clears selection and filters titles", "!document.querySelector('.storage-selection') && [...document.querySelectorAll('.storage-row-title')].every(row => row.textContent.includes('Storage row 1'))");
  await reset(); await click(".storage-table tbody input"); await click(".storage-pagination .btn:last-child"); await loaded();
  await check("changing page clears selection and reaches records beyond the first 50", "!document.querySelector('.storage-selection') && document.querySelectorAll('.storage-table tbody tr').length === 2 && document.querySelector('.storage-pagination p').textContent.startsWith('Page 2')");
  await reset(); await click(".storage-advanced summary");
  // The project filter is a select of real projects now, so an unmatched device name produces the empty result.
  await browser("fill", '[list="storage-sources"]', "No such device"); await loaded();
  await check("advanced filters have a clear empty result", "document.querySelectorAll('.storage-table tbody tr').length === 0 && document.querySelector('.storage-list-message').textContent.includes('Nothing matches')");
  await reset();
  await browser("select", ".storage-primary-filters label:nth-child(2) select", "ready");
  await browser("select", ".storage-primary-filters label:nth-child(3) select", "unexpired"); await loaded();
  const pair = (await request("/api/storage/handoffs?status=ready&expiration=unexpired")).handoffs.slice(0, 2);
  // With the advanced filters open the first rows sit at the bottom edge of the 1000 px viewport, where a click can miss.
  await evaluate("document.querySelector('.storage-table tbody tr:nth-child(2)').scrollIntoView({ block: 'center' })");
  await click(".storage-table tbody tr:nth-child(1) input"); await click(".storage-table tbody tr:nth-child(2) input");
  await evaluate("document.querySelector('.stage').scrollTo(0, 0)");
  await click(".storage-selection .btn.danger");
  await check("confirmation names permanent deletion and focuses Cancel", "document.querySelector('dialog[open][role=alertdialog]') && document.activeElement.textContent === 'Cancel' && document.querySelector('.storage-active-warning').textContent.includes('2 selected') && document.querySelector('.storage-confirm').textContent.includes('cannot be undone')");
  await browser("press", "Shift+Tab");
  await check("confirmation keeps keyboard focus inside the dialog", "document.querySelector('.storage-confirm').contains(document.activeElement)");
  await capture("desktop-confirmation");
  await request(`/api/handoffs/${pair[0].id}`, "PATCH", { status: "claimed", device: "Desktop", version: pair[0].version });
  await click(".storage-confirm .btn.danger");
  await wait("document.querySelector('.storage-notice')?.textContent.includes('1 deleted; 1 changed')"); await loaded();
  await check("partial conflict retains the failed selection after other deletion succeeds", "document.querySelector('.storage-selection strong').textContent === '1 selected' && !document.querySelector('dialog[open]')");
  assert.equal((await request(`/api/storage/handoffs/${pair[0].id}`)).version, 2);
  await reset();
  // Commit a real deletion, then lose only its response. A second POST would be an unsafe automatic retry.
  await evaluate(`window.__storageFetch = window.fetch; window.__storageDeleteCalls = 0; window.fetch = (url, options) => {
    if (url === '/api/storage/handoffs/delete' && options?.method === 'POST') {
      window.__storageDeleteCalls++; return window.__storageFetch(url, options).then(() => { throw new TypeError('Synthetic lost response'); });
    }
    return window.__storageFetch(url, options);
  }`);
  await click(".storage-table tbody input"); await click(".storage-selection .btn.danger"); await click(".storage-confirm .btn.danger");
  await wait("document.querySelector('.storage-notice')?.textContent.includes('could not be confirmed')"); await loaded();
  await check("lost deletion response refreshes reads and never retries the write", "window.__storageDeleteCalls === 1 && !document.querySelector('dialog[open]') && document.querySelector('.storage-selection strong').textContent === '1 selected'");
  await evaluate("window.fetch = window.__storageFetch"); await reset();
  await setLanguage("zh-CN");
  await check("Chinese labels cover storage and its controls", "document.querySelector('#storage-title').textContent === '存储管理' && document.querySelector('.storage-primary-filters').textContent.includes('排序方式') && document.querySelector('.storage-pagination').textContent.includes('下一页') && document.querySelector('.storage-images .btn').textContent === '清理图片'");
  await browser("set", "viewport", "390", "844");
  await evaluate("scrollTo(0, 0)");
  await check("mobile layout has no document overflow", "document.documentElement.scrollWidth <= innerWidth && document.querySelector('.storage-table tbody tr').getBoundingClientRect().width <= innerWidth");
  await capture("mobile-chinese");
  await click(".storage-table tbody input"); await click(".storage-selection .btn.danger");
  await check("mobile confirmation fits the viewport and names irreversibility", "document.querySelector('.storage-confirm').getBoundingClientRect().width <= innerWidth && document.querySelector('.storage-confirm').textContent.includes('无法恢复')");
  await capture("mobile-confirmation"); await browser("press", "Escape");
  await setLanguage("en"); await reset();
  // Blank only the physical measurement on the real summary, so the stub follows the current contract.
  await evaluate("window.__storageFetch = window.fetch; window.fetch = (url, options) => url === '/api/storage' ? window.__storageFetch(url, options).then(response => response.json()).then(summary => new Response(JSON.stringify({ ...summary, databaseBytes: null }), {status:200,headers:{'Content-Type':'application/json'}})) : window.__storageFetch(url, options)");
  await click(".storage-heading .btn");
  await wait("document.querySelector('.storage-meter-value')?.textContent === 'Unavailable'");
  await check("missing physical measurement displays unavailable rather than zero", "!document.querySelector('.storage-meter').hasAttribute('aria-valuenow') && document.querySelector('.storage-meter-value').textContent === 'Unavailable'");
  await evaluate("window.fetch = window.__storageFetch");
  await browser("set", "viewport", "1440", "1000"); await click(".storage-heading .btn"); await loaded();
  await capture("desktop-final");
  const errors = await browser("errors");
  await writeFile(path.join(output, "console.json"), JSON.stringify(errors, null, 2));
  checkConsole(errors);
  // The stage scrolls inside the window, and axe cannot judge contrast for content clipped by a scroll container, so scan with the page itself scrolling.
  await evaluate("document.querySelector('.app').style.height = 'auto'; document.querySelector('.stage').style.overflow = 'visible'");
  const accessibility = await browser("a11y", "--selector", ".storage-view");
  await writeFile(path.join(output, "accessibility.json"), JSON.stringify(accessibility, null, 2));
  assert.equal(accessibility.counts.violations, 0, "Storage has accessibility violations");
  assert.equal(accessibility.counts.incomplete, 0, "Storage has unresolved accessibility findings");
  checks.push("storage accessibility scan has no violations or incomplete findings");
  await browser("set", "media", "light", "reduced-motion");
  await check("Storage respects reduced-motion preferences", "parseFloat(getComputedStyle(document.querySelector('.storage-view')).animationDuration) < 0.01");
  // Sample entry is offered only by an empty inbox, so delete only this disposable owner's remaining rows first.
  const remaining = (await request("/api/storage/handoffs")).handoffs;
  if (remaining.length) await request("/api/storage/handoffs/delete", "POST", { items: remaining.map(({ id, version }) => ({ id, version })) });
  await browser("reload"); await wait("document.querySelector('.empty-actions .link, .setup-empty .setup-foot .link:not(.quiet)') !== null");
  await click(".empty-actions .link, .setup-empty .setup-foot .link:not(.quiet)"); await openStorage();
  await check("sample mode exposes no real storage management controls", "document.querySelector('.storage-view').textContent.includes('unavailable in sample mode') && !document.querySelector('.storage-table')");
  await writeFile(path.join(output, "results.json"), JSON.stringify({ base, checks, viewports: [[1440, 1000], [390, 844]], browser: "agent-browser", deployment: "not tested" }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  execFileSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", localConfig, "--persist-to", localState, "--command", `DELETE FROM handoffs WHERE owner_id = '${owner}';`], { stdio: "pipe", windowsHide: true });
  await browser("close").catch(() => {});
}

function checkConsole(value) {
  const errors = Array.isArray(value) ? value : value.errors ?? [];
  assert.equal(errors.length, 0, `Unexpected browser errors: ${JSON.stringify(errors)}`);
  checks.push("browser console has no runtime errors");
}
