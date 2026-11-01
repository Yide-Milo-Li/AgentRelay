// Run against a built local Worker with agent-browser installed; every record belongs to a disposable owner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5188";
if (!/^(127\.0\.0\.1|localhost)$/.test(new URL(base).hostname)) throw new Error("Keyboard checks only run against a local Worker.");
const run = crypto.randomUUID();
const session = `agentrelay-keys-${run.slice(0, 8)}`;
const headers = { "oai-authenticated-user-id": `keyboard-qa-${run}`, "oai-authenticated-user-email": "keyboard@sites.test" };
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const output = path.resolve(process.env.AGENTRELAY_QA_OUTPUT ?? `outputs/keyboard-shortcuts/${run}`);
const checks = [];
const prompt = "# Keyboard QA 中文 🚀\n\tindented <script>plain text</script>\n  trailing spaces  \n";
await mkdir(output, { recursive: true });

async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    // On Windows, the browser daemon can inherit CLI pipes; wait for CLI exit, not pipe closure.
    child.on("exit", code => {
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve(text); else reject(new Error(error || text || `agent-browser exited ${code}`));
    });
  });
  const result = JSON.parse(stdout.trim());
  if (!result.success) throw new Error(result.error);
  return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const press = key => browser("press", key);
const click = selector => browser("click", selector);
const fill = (selector, value) => browser("fill", selector, value);
const wait = expression => browser("wait", "--fn", expression);
const capture = async name => {
  // Capture settled dialogs rather than their translucent opening-transition frames.
  await wait("[...document.querySelectorAll('dialog[open]')].every(dialog => Number(getComputedStyle(dialog).opacity) >= 0.999 && dialog.getAnimations().every(animation => animation.playState !== 'running' && !animation.pending))");
  return browser("screenshot", path.join(output, `${name}.png`));
};
// Language, the single-key switch and the shortcut list live in Settings; each helper returns to the view it started from.
const currentView = () => evaluate("document.querySelector('.tabs [aria-current=page]')?.dataset.view ?? ''");
async function setLanguage(lang) {
  const view = await currentView();
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(`.lang-switch button[lang="${lang}"]`);
  if (view) await click(`.tabs [data-view="${view}"]`);
}
async function setShortcuts(enabled) {
  const view = await currentView() || "inbox";
  await click(".settings-button"); await click("[data-settings-section=general]");
  await browser(enabled ? "check" : "uncheck", ".shortcut-setting input");
  await click(`.tabs [data-view="${view}"]`);
  // Leaving a view closes the phone's detail, so reopen the selected handoff.
  if (["inbox", "done"].includes(view)) await click('.row[aria-current="true"]');
}
let helpOrigin = "";
async function openHelp() {
  helpOrigin = await currentView();
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(".shortcuts-button");
}
async function closeHelp() { await press("Escape"); if (helpOrigin) await click(`.tabs [data-view="${helpOrigin}"]`); }
async function check(name, expression) {
  assert.equal(await evaluate(expression), true, name);
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function request(url, method = "GET", data) {
  const response = await fetch(base + url, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data && JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${url}: ${response.status}`);
  return response.json();
}
async function create(title) {
  return request("/api/handoffs", "POST", { title, content: prompt, sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID() });
}

async function verifyLifecycleShortcuts() {
  const a = await create("Lifecycle A"), b = await create("Lifecycle B"), c = await create("Lifecycle C"), d = await create("Lifecycle D");
  await request(`/api/handoffs/${c.id}`, "PATCH", { status: "claimed", version: c.version, device: "Desktop" });
  await press("1"); await click(".sync");
  await wait("[...document.querySelectorAll('.row strong')].some(row => row.textContent === 'Lifecycle A')");
  await evaluate(`window.__lifecycleFetch = window.fetch; window.__lifecycleCalls = [];
    window.fetch = (url, options) => {
      if (url === '/api/handoffs' && (!options?.method || options.method === 'GET') && window.__freezeLifecycleList) {
        return Promise.resolve(new Response(JSON.stringify(window.__lifecycleList), { headers: { 'Content-Type': 'application/json' } }));
      }
      if (typeof url === 'string' && url.startsWith('/api/handoffs/') && options?.method === 'PATCH') {
        const call = { url, ...JSON.parse(options.body) }; window.__lifecycleCalls.push(call); window.__freezeLifecycleList = false;
        const send = () => window.__lifecycleFetch(url, options).then(response => { call.response = response.status; return response; });
        if (window.__holdLifecycle) return new Promise((resolve, reject) => { window.__releaseLifecycle = () => send().then(resolve, reject); });
        return send();
      }
      return window.__lifecycleFetch(url, options);
    }`);
  async function enter(title) {
    await press("/"); await fill(".search input", title); await evaluate("document.activeElement.blur()"); await press("j"); await press("Enter");
    await wait(`document.activeElement.matches('.prompt') && document.querySelector('.detail h1')?.textContent === ${JSON.stringify(title)}`);
  }
  try {
    await press("/"); await fill(".search input", "Lifecycle A");
    await press("Shift+c"); await press("Shift+d");
    await check("status shortcuts leave search input untouched by mutations", "window.__lifecycleCalls.length === 0 && document.activeElement.matches('.search input')");
    await fill(".search input", "Lifecycle A"); await evaluate("document.activeElement.blur()");
    await press("Shift+c"); await press("Shift+d");
    await check("a fallback preview nobody selected cannot be claimed or completed", "window.__lifecycleCalls.length === 0 && document.querySelector('.detail h1')?.textContent === 'Lifecycle A'");
    await press("j"); await press("Enter"); await press("c"); await press("d"); await press("Shift+d");
    await check("plain C/D and complete on a Ready handoff do nothing", "window.__lifecycleCalls.length === 0");
    await evaluate("{ const target = document.activeElement; target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); }");
    await press("Shift+c");
    await evaluate("{ const target = document.activeElement; target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); for (const extra of [{ repeat: true }, { keyCode: 229 }, { isComposing: true }]) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', shiftKey: true, bubbles: true, cancelable: true, ...extra })); }");
    await check("lifecycle shortcuts ignore IME and held-key events", "window.__lifecycleCalls.length === 0");
    await click(".menu-wrap > button"); await press("Shift+c");
    await check("menu blocks lifecycle shortcuts", "window.__lifecycleCalls.length === 0 && !!document.querySelector('[role=menu]')");
    await press("Escape"); await click(".menu-wrap > button"); await click('[role="menuitem"].danger'); await press("Shift+c");
    await check("delete confirmation blocks lifecycle shortcuts", "window.__lifecycleCalls.length === 0 && !!document.querySelector('.confirm')");
    await press("Escape"); await press("?"); await press("Shift+c");
    await check("help blocks lifecycle shortcuts", "window.__lifecycleCalls.length === 0 && !!document.querySelector('.shortcut-dialog[open]')");
    await press("Escape"); await setShortcuts(false); await browser("focus", ".prompt"); await press("Shift+c"); await press("Shift+d");
    await check("single-key preference disables both status shortcuts", "window.__lifecycleCalls.length === 0 && document.activeElement.matches('.prompt')");
    await setShortcuts(true); await browser("focus", ".prompt");

    // Both events run before a React commit: only the synchronous mutation lock can reject the second one.
    await evaluate("{ window.__holdLifecycle = true; const target = document.activeElement; for (let i = 0; i < 2; i++) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', shiftKey: true, bubbles: true, cancelable: true })); }");
    await press("Shift+c"); await press("Shift+d");
    await check("same-tick and pending status events produce one versioned request", `window.__lifecycleCalls.length === 1 && window.__lifecycleCalls[0].url === '/api/handoffs/${a.id}' && window.__lifecycleCalls[0].version === ${a.version} && window.__lifecycleCalls[0].status === 'claimed' && window.__lifecycleCalls[0].device === 'laptop' && document.querySelector('[aria-keyshortcuts="Shift+c"]').disabled`);
    await evaluate("window.__holdLifecycle = false; window.__releaseLifecycle(); true");
    await wait("document.querySelector('[aria-keyshortcuts=\"Shift+d\"]:not(:disabled)') !== null");
    await check("successful claim keeps prompt focus for copying", "document.activeElement.matches('.prompt') && window.__lifecycleCalls.length === 1");
    const claimedA = await request(`/api/handoffs/${a.id}`);
    assert.equal(claimedA.status, "claimed"); assert.equal(claimedA.claimedByDeviceId, "laptop"); assert.equal(claimedA.version, a.version + 1);
    checks.push("claim persists attribution and exactly one version increment");
    await press("Shift+c");
    await check("claim never advances an already claimed handoff to Done", "window.__lifecycleCalls.length === 1");
    await capture("desktop-lifecycle-claimed");

    await press("/"); await fill(".search input", "Lifecycle"); await browser("focus", ".prompt"); await press("Shift+d");
    await wait("document.activeElement.matches('.row') && document.querySelector('.detail h1')?.textContent !== 'Lifecycle A'");
    await press("Shift+d"); await press("Shift+d");
    await check("complete returns focus to list and cannot complete its replacement preview", "window.__lifecycleCalls.length === 2 && document.activeElement.matches('.row')");
    assert.equal((await request(`/api/handoffs/${a.id}`)).status, "done");
    assert.equal((await request(`/api/handoffs/${c.id}`)).status, "claimed");
    checks.push("completion affects only the originally focused handoff");
    await press("Control+z");
    await wait("window.__lifecycleCalls.at(-1)?.response === 200");
    await check("Ctrl+Z undoes the completion by version, whatever is selected", `window.__lifecycleCalls.length === 3 && window.__lifecycleCalls[2].url === '/api/handoffs/${a.id}' && window.__lifecycleCalls[2].status === 'claimed' && window.__lifecycleCalls[2].undo === true && window.__lifecycleCalls[2].version === ${a.version + 2}`);
    const undoneA = await request(`/api/handoffs/${a.id}`);
    assert.equal(undoneA.status, "claimed"); assert.equal(undoneA.claimedByDeviceId, "laptop"); assert.equal(undoneA.version, a.version + 3);
    checks.push("undone completion keeps the original claimant");
    await press("Control+z");
    await check("a second Ctrl+Z has nothing left to undo", "window.__lifecycleCalls.length === 3");

    await click(".segmented button:nth-child(2)"); await enter("Lifecycle B"); await press("Shift+c");
    await wait("document.querySelectorAll('.row').length === 0 && document.activeElement.matches('.search input')");
    await check("claim leaving Ready filter returns focus to empty-list search", "!document.querySelector('.workspace.show-detail') && window.__lifecycleCalls.length === 4");
    assert.equal((await request(`/api/handoffs/${b.id}`)).status, "claimed");

    const conflict = await create("Lifecycle stale version");
    await fill(".search input", "Lifecycle stale version"); await click(".sync"); await wait("document.querySelectorAll('.row').length === 1"); await enter("Lifecycle stale version");
    // Freeze only polling reads until the key is pressed, keeping the stale-version race deterministic.
    await evaluate("(async () => { window.__lifecycleList = await window.__lifecycleFetch('/api/handoffs').then(response => response.json()); window.__freezeLifecycleList = true; return true; })()");
    await request(`/api/handoffs/${conflict.id}`, "PATCH", { status: "claimed", version: conflict.version, device: "Desktop" });
    await press("Shift+c");
    await wait("window.__lifecycleCalls.at(-1)?.response === 409 && document.activeElement.matches('.search input')");
    await check("stale shortcut refreshes without retrying or advancing state", "window.__lifecycleCalls.length === 5 && document.querySelectorAll('.row').length === 0");
    const conflictRow = await request(`/api/handoffs/${conflict.id}`);
    assert.equal(conflictRow.status, "claimed"); assert.equal(conflictRow.claimedByDeviceId, "desktop"); assert.equal(conflictRow.version, conflict.version + 1);
    checks.push("CAS conflict preserves the other device's claim");

    await click(".segmented button:first-child"); await fill(".search input", "Lifecycle D"); await evaluate("document.activeElement.blur()"); await press("j");
    await press("Shift+c");
    await wait("window.__lifecycleCalls.at(-1)?.response === 200");
    await check("a row picked with J claims while focus stays in the list", "window.__lifecycleCalls.length === 6 && document.activeElement.matches('.row') && document.querySelector('.detail .actions [aria-keyshortcuts=\"Shift+d\"]') !== null");
    await press("Control+z");
    await wait("window.__lifecycleCalls.at(-1)?.response === 200 && window.__lifecycleCalls.length === 7");
    const undoneD = await request(`/api/handoffs/${d.id}`);
    assert.equal(undoneD.status, "ready"); assert.equal(undoneD.claimedByDeviceId, null); assert.equal(undoneD.version, d.version + 2);
    checks.push("Ctrl+Z returns an accidental claim to Ready and clears its claimant");

    await click(".segmented button:first-child"); await browser("set", "viewport", "390", "844"); await enter("Lifecycle C");
    await capture("mobile-lifecycle-claimed"); await press("Shift+d");
    await wait("!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.search input')");
    await press("Shift+d");
    await check("narrow completion returns to list and cannot mutate a hidden detail", "window.__lifecycleCalls.length === 8 && !document.querySelector('.detail h1')");
    assert.equal((await request(`/api/handoffs/${c.id}`)).status, "done");
    assert.equal((await request(`/api/handoffs/${b.id}`)).status, "claimed");
    checks.push("narrow completion leaves unrelated claims unchanged");
    await setLanguage("zh-CN"); await openHelp();
    await check("help includes translated lifecycle actions and shared key labels", "[...document.querySelectorAll('.shortcut-list dt')].some(item => item.textContent.includes('领取选中')) && [...document.querySelectorAll('.shortcut-list kbd')].some(item => item.textContent === 'Shift + D')");
    await capture("mobile-lifecycle-help-zh"); await closeHelp();
    await browser("set", "viewport", "1440", "900"); await setLanguage("en"); await openHelp(); await capture("desktop-lifecycle-help-en"); await closeHelp();
  } finally {
    await evaluate("window.fetch = window.__lifecycleFetch; true");
  }
}

try {
  // Sending requires a registered current device, so both route ends are registered before the page loads.
  await request("/api/devices", "POST", { name: "Laptop" });
  await request("/api/devices", "POST", { name: "Desktop" });
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "900");
  await evaluate("localStorage.setItem('agentrelay.device.v2', 'laptop'); localStorage.setItem('agentrelay.device.chosen.v1', '1'); true");
  await browser("reload");
  await wait("document.querySelector('.empty-actions .link, .setup-empty .setup-foot .link:not(.quiet)') !== null");
  await click(".empty-actions .link, .setup-empty .setup-foot .link:not(.quiet)");
  await press("j");
  await check("sample navigation changes preview and keeps mutations disabled", "document.activeElement.matches('.row') && document.querySelector('.actions .btn:not(.primary)').disabled");
  await press("Enter"); await press("Shift+c"); await press("Shift+d");
  await check("sample mode keeps lifecycle actions disabled even with detail focus", "document.activeElement.matches('.prompt') && document.querySelector('.actions .btn:not(.primary)').disabled");
  assert.equal((await request("/api/handoffs")).handoffs.length, 0);
  checks.push("sample navigation persists no records");
  await click(".banner.note button");

  await create("Keyboard QA A");
  await create("Keyboard QA B");
  const claimed = await create("Keyboard QA C");
  await request(`/api/handoffs/${claimed.id}`, "PATCH", { status: "claimed", version: claimed.version, device: "Desktop" });
  const done = await create("Keyboard QA Done");
  const inProgress = await request(`/api/handoffs/${done.id}`, "PATCH", { status: "claimed", version: done.version, device: "Desktop" });
  await request(`/api/handoffs/${done.id}`, "PATCH", { status: "done", version: inProgress.version });
  await click(".sync");
  await wait("document.querySelectorAll('.row').length === 3");

  await press("/");
  await check("slash focuses search", "document.activeElement.matches('.search input')");
  await fill(".search input", "njky/?");
  await check("typing shortcut characters only edits search", "!document.querySelector('dialog[open]') && document.querySelector('.search input').value === 'njky/?'");
  await press("Escape");
  await check("first search Escape clears without leaving the field", "document.activeElement.matches('.search input') && document.activeElement.value === ''");
  await press("Escape");
  await check("second search Escape restores row focus", "document.activeElement.matches('.row')");
  await press("j");
  await check("J updates desktop preview and focus together", "document.activeElement.matches('.row') && document.activeElement.querySelector('strong').textContent === document.querySelector('.detail h1').textContent");
  await press("k"); await press("k");
  await check("K stops at the first row", "document.activeElement === document.querySelector('.row')");
  await press("j"); await press("j"); await press("j");
  await check("J stops at the last row", "document.activeElement === [...document.querySelectorAll('.row')].at(-1)");
  await press("Enter");
  await check("Enter opens the row with prompt focus", "document.activeElement.matches('.prompt')");
  await evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } })");
  await press("y");
  await check("Y copies the exact full prompt and uses existing success feedback", `window.__copied === ${JSON.stringify(prompt)} && !!document.querySelector('.actions .primary[data-done]')`);
  await evaluate("navigator.clipboard.writeText = async () => { throw Error('blocked'); }; window.__execCommand = document.execCommand; document.execCommand = () => { window.__copied = document.querySelector('body > textarea').value; return true; }");
  await press("y");
  await check("clipboard fallback preserves exact text and keyboard focus", `window.__copied === ${JSON.stringify(prompt)} && document.activeElement.matches('.prompt')`);
  await evaluate("document.execCommand = window.__execCommand; delete navigator.clipboard;");
  await click(".segmented button:nth-child(2)");
  await press("j");
  await check("navigation uses filtered rows", "document.querySelectorAll('.row').length === 2 && document.activeElement === [...document.querySelectorAll('.row')].at(-1)");
  await press("/"); await fill(".search input", "missing-keyboard-record"); await evaluate("document.activeElement.blur()"); await press("j");
  await check("navigation on an empty filter is harmless", "document.querySelectorAll('.row').length === 0 && !document.querySelector('dialog[open]')");
  await press("/"); await press("Escape"); await press("Escape");

  await evaluate("document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))");
  await press("n");
  await check("active composition blocks global shortcuts", "!document.querySelector('dialog[open]')");
  await evaluate("document.activeElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); for (const extra of [{ keyCode: 229 }, { repeat: true }]) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, ...extra }));");
  await check("legacy IME and repeat events do not open compose", "!document.querySelector('dialog[open]')");
  await browser("focus", ".select-quiet select"); await press("n");
  await check("native selects retain character keys", "!document.querySelector('dialog[open]')");
  await click(".device-pick"); await wait("document.querySelector('.device-menu') !== null"); await press("n");
  await check("the open device menu blocks global shortcuts", "!document.querySelector('dialog[open]')");
  await press("Escape");
  await check("Escape closes the device menu and returns focus to the picker", "!document.querySelector('.device-menu') && document.activeElement.classList.contains('device-pick')");
  await evaluate("const editable = document.createElement('div'); editable.id = 'keyboard-editable'; editable.contentEditable = 'true'; document.body.appendChild(editable); editable.focus()");
  await press("n");
  await check("contenteditable retains character keys", "!document.querySelector('dialog[open]') && document.activeElement.id === 'keyboard-editable'");
  await evaluate("document.querySelector('#keyboard-editable').remove()");

  await press("n");
  await check("N opens compose with title focus", "document.activeElement.name === 'title'");
  await press("Escape");
  await check("clean compose closes and restores its opener", "!document.querySelector('dialog[open]') && document.activeElement.matches('.new')");
  await press("n"); await fill('[name="title"]', "Keyboard sent via Ctrl");
  await fill('[name="content"]', prompt);
  await press("Escape");
  await check("dirty Escape asks to discard and focuses continue editing", "document.activeElement.textContent === 'Continue editing' && !!document.querySelector('[role=alertdialog]')");
  await capture("desktop-discard");
  await press("Escape");
  await check("Escape in discard returns to the original field with data intact", `!!document.querySelector('dialog[open]') && !document.querySelector('[role=alertdialog]') && document.activeElement.name === 'content' && document.activeElement.value === ${JSON.stringify(prompt)}`);
  await click(".compose-head .icon");
  await check("close button also requests discard", "!!document.querySelector('[role=alertdialog]')");
  await click(".discard-confirm .btn:not(.danger)");
  await evaluate("const modal = document.querySelector('dialog[open]'); modal.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await check("backdrop close also requests discard", "!!document.querySelector('[role=alertdialog]')");
  await press("Escape");
  await fill('[name="title"]', ""); await browser("focus", '[name="content"]'); await press("Control+Enter");
  await check("shortcut send retains required-field validation", "document.activeElement.name === 'title' && !document.querySelector('.form-error') && !document.querySelector('[name=title]').validity.valid");
  await fill('[name="title"]', "Keyboard sent via Ctrl");
  // First attempt fails locally; the second is held pending to test retry identity and the synchronous lock.
  await evaluate(`window.__fetch = window.fetch; window.__attempts = []; window.fetch = (url, options) => {
    if (url === '/api/handoffs' && options?.method === 'POST') {
      window.__attempts.push(JSON.parse(options.body));
      if (window.__attempts.length === 1) return Promise.reject(new TypeError('Synthetic connection loss'));
      return new Promise((resolve, reject) => { window.__releaseSend = () => window.__fetch(url, options).then(resolve, reject); });
    }
    return window.__fetch(url, options);
  }`);
  await browser("focus", '[name="content"]'); await press("Control+Enter");
  await wait("document.querySelector('.form-error') !== null");
  await check("failed send keeps all input and enables retry", `document.querySelector('[name=content]').value === ${JSON.stringify(prompt)} && !document.querySelector('button[type=submit]').disabled`);
  await press("Control+Enter"); await press("Escape"); await press("Control+Enter");
  await check("pending send blocks close and duplicate submits, retaining requestKey", "!!document.querySelector('dialog[open]') && document.querySelector('button[type=submit]').disabled && window.__attempts.length === 2 && window.__attempts[0].requestKey === window.__attempts[1].requestKey");
  await evaluate("window.__releaseSend(); true");
  await wait("!document.querySelector('dialog[open]')");
  await check("successful shortcut send focuses the created prompt", "document.activeElement.matches('.prompt') && document.querySelector('.detail h1').textContent === 'Keyboard sent via Ctrl'");
  const sent = (await request("/api/handoffs")).handoffs.filter(row => row.title === "Keyboard sent via Ctrl");
  assert.equal(sent.length, 1); assert.equal(sent[0].content, prompt);
  checks.push("shortcut send persists one record with exact prompt text");
  await evaluate("window.fetch = window.__fetch");

  await press("?");
  await check("question mark opens help and focuses its close control", "document.activeElement.matches('.shortcut-dialog .icon')");
  await capture("desktop-help");
  await press("Escape"); await setShortcuts(false); await browser("focus", ".prompt"); await press("n"); await press("/"); await press("j"); await press("?");
  await check("disabled single keys do nothing", "!document.querySelector('dialog[open]') && document.activeElement.matches('.prompt')");
  await browser("reload"); await wait("document.querySelector('.detail h1') !== null"); await click(".settings-button");
  await check("single-key preference survives reload", "!document.querySelector('.shortcut-setting input').checked");
  await click('.tabs [data-view="inbox"]'); await click(".new"); await fill('[name="title"]', "Keyboard sent via Meta"); await fill('[name="content"]', prompt); await press("Meta+Enter");
  await wait("!document.querySelector('dialog[open]')");
  await check("Meta Enter still sends when single keys are disabled", "document.querySelector('.detail h1').textContent === 'Keyboard sent via Meta' && document.activeElement.matches('.prompt')");
  await setShortcuts(true);
  await click(".segmented button:nth-child(2)");

  await browser("set", "viewport", "390", "844");
  await press("Escape");
  await check("narrow Escape returns to selected row", "!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.row')");
  await press("j");
  await check("narrow J keeps the list visible", "!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.row')");
  await capture("mobile-list");
  await press("Enter");
  await check("narrow Enter opens detail and focuses prompt", "!!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.prompt')");
  await click(".menu-wrap > button"); await press("n");
  await check("open menu blocks background new shortcut", "!!document.querySelector('[role=menu]') && !document.querySelector('dialog[open]')");
  await press("Escape");
  await check("one Escape closes only the menu", "!document.querySelector('[role=menu]') && !!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.menu-wrap > button')");
  await click(".menu-wrap > button"); await click('[role="menuitem"].danger'); await press("Escape");
  await check("Escape cancels delete without leaving detail", "!document.querySelector('.confirm') && !!document.querySelector('.workspace.show-detail')");
  await press("/");
  await check("slash from narrow detail restores search and preserves filters", "!document.querySelector('.workspace.show-detail') && document.activeElement.matches('.search input') && document.querySelector('.segmented button:nth-child(2)').getAttribute('aria-pressed') === 'true'");
  await press("Escape"); await press("Enter");
  await setLanguage("zh-CN"); await browser("set", "media", "dark", "reduced-motion");
  await capture("mobile-dark-chinese");
  await check("Chinese narrow dark mode has no horizontal overflow", "document.documentElement.lang === 'zh-CN' && document.documentElement.scrollWidth <= innerWidth");
  await openHelp();
  await check("help and settings are translated", "document.querySelector('#shortcuts-title').textContent === '键盘快捷键' && document.querySelector('.shortcut-setting').textContent.includes('启用单键快捷键')");
  await capture("mobile-dark-chinese-help");
  await browser("set", "viewport", "320", "740");
  await check("help fits a 320px viewport", "document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').getBoundingClientRect().right <= innerWidth");
  await press("Escape");
  await check("header fits a 320px viewport", "document.documentElement.scrollWidth <= innerWidth");
  await browser("set", "viewport", "1440", "900"); await browser("set", "media", "light"); await setLanguage("en");
  await press("2");
  await check("2 switches to Done tab and focuses it", "document.querySelector('.tab[data-view=\"done\"][aria-current=\"page\"]') !== null && document.activeElement === document.querySelector('.tab[data-view=\"done\"]')");
  await press("j"); await press("Enter");
  await check("Done supports navigation and opening", "document.querySelector('.detail h1').textContent === 'Keyboard QA Done' && document.activeElement.matches('.prompt')");
  await press("3");
  await check("3 switches to Devices tab and focuses it", "document.querySelector('.tab[data-view=\"devices\"][aria-current=\"page\"]') !== null && !!document.querySelector('.devices')");
  await press("5");
  await check("5 opens Settings and focuses its button", "document.querySelector('.settings-button[aria-current=\"page\"]') !== null && document.activeElement.matches('.settings-button') && !!document.querySelector('.settings')");
  await press("1");
  await check("1 switches back to Inbox tab and focuses it", "document.querySelector('.tab[data-view=\"inbox\"][aria-current=\"page\"]') !== null && !!document.querySelector('.workspace')");
  await press("4");
  await check("4 switches to Agents tab and focuses it", "document.querySelector('.tab[data-view=\"agent\"][aria-current=\"page\"]') !== null && !!document.querySelector('.guide')");
  await press("/");
  await check("search shortcut does not leave Agents", "!!document.querySelector('.guide') && !document.querySelector('.search input')");
  await press("n"); await fill('[name="title"]', "Discard probe"); await press("Escape");
  await press("Tab");
  await check("discard confirmation keeps keyboard focus within its choices", "document.activeElement.matches('.discard-confirm .danger')");
  await press("Tab");
  await check("discard confirmation wraps to continue editing", "document.activeElement.textContent === 'Continue editing'");
  await click(".discard-confirm .danger");
  await check("explicit discard closes the unsent form", "!document.querySelector('dialog[open]')");
  await press("?");
  await check("Agents supports new and help shortcuts", "!!document.querySelector('.guide') && !!document.querySelector('.shortcut-dialog[open]')");
  await press("Shift+Tab");
  await check("help keeps backward Tab inside the dialog", "document.activeElement.matches('.shortcut-dialog .icon')");
  await press("Tab");
  await check("help wraps forward Tab to close", "document.activeElement.matches('.shortcut-dialog .icon')");
  await capture("desktop-light-help");
  await press("Escape"); await capture("desktop-final");
  await verifyLifecycleShortcuts();
  const errors = await browser("errors");
  assert.ok(!errors.errors?.length, JSON.stringify(errors));
  checks.push("no browser runtime errors");
} finally {
  const { handoffs } = await request("/api/handoffs");
  for (const row of handoffs) await request(`/api/handoffs/${row.id}`, "DELETE", { version: row.version });
  const { devices } = await request("/api/devices");
  for (const device of devices) await request(`/api/devices/${device.id}`, "DELETE", { version: device.version });
  await writeFile(path.join(output, "browser-results.json"), JSON.stringify({ base, passed: checks.length, checks }, null, 2) + "\n");
  await browser("close");
}
console.log(JSON.stringify({ passed: checks.length, output }, null, 2));
