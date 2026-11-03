// The paged inbox list in a browser, against a disposable built Worker: Show more, the detail read per selection, search
// past the preview, the Done view, the server's thread, and the phone layout in Chinese and dark mode. Run it through
//   node tests/integration/run-notification-events.mjs tests/e2e/inbox-list.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Inbox list browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `inbox-browser-${run}`, session = `inbox-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/inbox-list-e2e/${run}`), headers = identityHeaders(owner, "inbox@sites.test");
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const checks = [];
await mkdir(output, { recursive: true });

async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    // On Windows, the browser daemon can inherit CLI pipes; wait for CLI exit, not pipe closure.
    child.on("exit", code => { child.stdout.destroy(); child.stderr.destroy(); if (code === 0) resolve(text); else reject(new Error(error || text)); });
  });
  const result = JSON.parse(stdout.trim()); if (!result.success) throw new Error(result.error); return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const click = selector => browser("click", selector);
const fill = (selector, value) => browser("fill", selector, value);
const wait = expression => browser("wait", "--fn", expression);
const capture = name => browser("screenshot", path.join(output, `${name}.png`));
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); console.log(`PASS ${name}`); }
async function request(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
}
const rows = "document.querySelectorAll('.list .row').length";
const titleOf = "document.querySelector('.detail:not([aria-busy]) h1')?.textContent";
const create = (title, content = `Prompt of ${title}`) => request("/api/handoffs", "POST", { title, content, sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID() });

try {
  // 56 waiting handoffs, created oldest first; the oldest hides its search word far past the 180-character preview.
  await create("Inbox row 0", `${"Context. ".repeat(60)}DeepSearchWord at the end`);
  for (let index = 1; index < 56; index += 1) await create(`Inbox row ${index}`);
  const parent = (await request("/api/handoffs?view=summary&q=Inbox%20row%201&limit=500")).handoffs.find(row => row.title === "Inbox row 1");
  const reply = await request("/api/handoffs", "POST", { replyTo: parent.id, content: "A question about row 1", requestKey: crypto.randomUUID() });
  const finished = await create("Finished row");
  const claimed = await request(`/api/handoffs/${finished.id}`, "PATCH", { status: "claimed", version: finished.version, device: "Desktop" });
  await request(`/api/handoffs/${finished.id}`, "PATCH", { status: "done", version: claimed.version, device: "Desktop", result: "## Summary\nShipped." });

  await browser("set", "viewport", "1440", "900");
  await browser("--headers", JSON.stringify(headers), "open", base);
  await wait(`${rows} === 50`);
  await check("the inbox shows one page of 50 and offers more", `${rows} === 50 && document.querySelector('.list-more')?.textContent === 'Show more'`);
  await check("the badge counts every waiting handoff", "document.querySelector('.tab[data-view=inbox] .tab-count').textContent === '57'");
  await click(".list-more");
  await wait(`${rows} === 57`);
  await check("Show more loads the rest and then disappears", `${rows} === 57 && !document.querySelector('.list-more')`);
  await check("the browser never asks for the full list", "performance.getEntriesByType('resource').filter(entry => /\\/api\\/handoffs(\\?|$)/.test(new URL(entry.name).pathname + new URL(entry.name).search)).every(entry => entry.name.includes('view='))");

  await evaluate(`[...document.querySelectorAll('.list .row')].find(row => row.querySelector('.row-head strong').textContent === 'Inbox row 0').click(); true`);
  await wait(`${titleOf} === 'Inbox row 0'`);
  await check("the selected handoff's full prompt is read for the detail", "document.querySelector('.detail .prompt').textContent.includes('DeepSearchWord at the end')");

  await fill(".search input", "deepsearchword");
  await wait(`${rows} === 1`);
  await check("search finds a word past the preview, in any ASCII case", `document.querySelector('.list .row .row-head strong').textContent === 'Inbox row 0'`);
  await click(".search .icon");
  await wait(`${rows} === 50`);

  await evaluate(`[...document.querySelectorAll('.list .row')].find(row => row.querySelector('.row-head strong').textContent === ${JSON.stringify(reply.title)}).click(); true`);
  await wait(`${titleOf} === ${JSON.stringify(reply.title)} && document.querySelectorAll('.thread-item').length === 2`);
  await check("a reply shows its thread from the server", "document.querySelectorAll('.thread-item').length === 2");
  await evaluate("[...document.querySelectorAll('.thread-item')].find(item => !item.disabled).click(); true");
  await wait(`${titleOf} === 'Inbox row 1'`);
  await check("a thread entry opens its handoff", `${titleOf} === 'Inbox row 1'`);
  await capture("inbox-desktop");

  await click('.tabs [data-view="done"]');
  await wait(`${rows} === 1 && ${titleOf} === 'Finished row'`);
  await check("Done lists finished handoffs and shows the receipt", "document.querySelector('.detail .receipt')?.textContent.includes('Shipped.')");

  await click('.tabs [data-view="inbox"]');
  await click(".settings-button"); await click("[data-settings-section=general]"); await click('.lang-switch button[lang="zh-CN"]'); await click('.tabs [data-view="inbox"]');
  await browser("set", "viewport", "390", "844"); await browser("set", "media", "dark");
  await wait(`${rows} === 50`);
  await check("the phone layout keeps the list and Show more inside the screen", `document.documentElement.scrollWidth <= innerWidth && document.querySelector('.list-more').textContent === '显示更多'`);
  await capture("inbox-phone-zh-dark");
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} finally {
  await browser("close").catch(() => {});
}
