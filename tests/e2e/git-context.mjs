// Browser acceptance for Git context: the branch marker in inbox rows and the code-state row in the detail pane.
// Uses a disposable owner on the built local Worker, never a live Site.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Git context browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `git-context-browser-${run}`, session = `git-context-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/git-context-e2e/${run}`), headers = identityHeaders(owner, "git-context@sites.test");
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const checks = [], ids = [];
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
const capture = name => browser("screenshot", path.join(output, `${name}.png`));
async function setLanguage(lang) {
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(`.lang-switch button[lang="${lang}"]`);
  await click('.tabs [data-view="inbox"]');
}
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); console.log(`PASS ${name}`); }
async function request(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
}
const send = async (title, git = {}) => { const row = await request("/api/handoffs", "POST", { title, content: `# ${title}`, project: "web-app", sourceDevice: "laptop", targetDevice: "desktop", requestKey: crypto.randomUUID(), ...git }); ids.push(row.id); return row; };
const SHA1 = "0123456789abcdef0123456789abcdef01234567", SHA256 = "ab".repeat(32), LONG = `feat/${"long-branch-name-".repeat(12)}`.slice(0, 200);
const rowBranches = "[...document.querySelectorAll('.list .row')].map(row => row.querySelector('.row-branch')?.textContent ?? '').join('|')";
const noOverflow = "[...document.querySelectorAll('.list, .detail, .code-state')].every(node => node.scrollWidth <= node.clientWidth + 1) && document.documentElement.scrollWidth <= innerWidth";
// Open the n-th inbox row and wait until the detail shows it.
const open = async (index, title) => { await evaluate(`document.querySelectorAll('.list .row')[${index}].click(); true`); await wait(`document.querySelector('.detail h1')?.textContent === ${JSON.stringify(title)}`); };

try {
  for (const name of ["Laptop", "Desktop"]) await request("/api/devices", "POST", { name });
  // Oldest first, so the inbox (newest first) reads Branch, Shell, Long, Detached, Plain.
  await send("Plain");
  await send("Detached", { baseCommit: SHA256 });
  await send("Long", { branch: LONG, baseCommit: SHA1 });
  await send("Shell", { branch: "it's;$x", baseCommit: SHA1 });
  await send("Branch", { branch: "feat/login-flow", baseCommit: SHA1 });

  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "900");
  await browser("set", "media", "light");
  await wait("document.querySelectorAll('.list .row').length === 5");

  await check("rows show the branch, and nothing for a detached base or no context", `${rowBranches} === ${JSON.stringify(["feat/login-flow", "it's;$x", LONG, "", ""].join("|"))}`);
  await check("a long branch is cut with an ellipsis inside the row", "(() => { const node = [...document.querySelectorAll('.row-branch span')][2]; return getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth && node.closest('.row').scrollWidth <= node.closest('.row').clientWidth + 1; })()");
  await check("the row marker names the branch for assistive tech", "document.querySelector('.row-branch').getAttribute('aria-label') === 'Branch feat/login-flow'");

  await open(0, "Branch");
  await check("the detail shows the branch and the short commit", "(() => { const codes = [...document.querySelectorAll('.code-state code')].map(node => node.textContent); return codes.join('|') === 'feat/login-flow|0123456'; })()");
  await check("the full hash is in the commit's spoken label", `document.querySelectorAll('.code-state code')[1].getAttribute('aria-label') === 'Commit ${SHA1}'`);
  await check("the code state sits between the route and the prompt", "(() => { const state = document.querySelector('.code-state'); return state.previousElementSibling.matches('.route-full') && state.nextElementSibling.matches('.prompt-header'); })()");
  await check("the code state holds no links", "document.querySelectorAll('.code-state a').length === 0");
  await check("the note says uncommitted changes are not included", "document.querySelector('.code-state .attach-note').textContent.startsWith('Uncommitted changes are not included')");
  await evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } }); true");
  await click(".code-state button");
  await wait("window.__copied !== undefined");
  await check("copy gives the switch commands", "window.__copied === 'git fetch && git switch feat/login-flow && git status'");
  await check("the copy button confirms", "document.querySelector('.code-state button').hasAttribute('data-done')");
  await capture("desktop-light-en");

  await open(1, "Shell");
  await evaluate("window.__copied = undefined; true");
  await click(".code-state button");
  await wait("window.__copied !== undefined");
  await check("shell syntax in a branch name is quoted", `window.__copied === ${JSON.stringify("git fetch && git switch 'it'\\''s;$x' && git status")}`);

  await open(2, "Long");
  await check("a 200-character branch wraps in the detail without overflow", noOverflow);
  await capture("desktop-long-branch");

  await open(3, "Detached");
  await check("a detached base shows only the commit", `[...document.querySelectorAll('.code-state code')].map(node => node.textContent).join('|') === ${JSON.stringify(SHA256.slice(0, 7))}`);
  await evaluate("window.__copied = undefined; true");
  await click(".code-state button");
  await wait("window.__copied !== undefined");
  await check("copy detaches at the commit", `window.__copied === 'git fetch && git switch --detach ${SHA256}'`);

  await open(4, "Plain");
  await check("a handoff without git context has no code-state row", "!document.querySelector('.code-state')");

  await open(0, "Branch");
  await setLanguage("zh-CN");
  await wait("document.querySelector('.code-state .prompt-header-title')?.textContent === '代码状态'");
  await check("Chinese labels the row and marker", "document.querySelector('.code-state button').getAttribute('aria-label') === '复制检出命令' && document.querySelector('.row-branch').getAttribute('aria-label') === '分支 feat/login-flow'");
  await capture("desktop-light-zh");
  await browser("set", "media", "dark"); await capture("desktop-dark-zh");
  await setLanguage("en"); await capture("desktop-dark-en");
  await browser("set", "media", "light");

  await browser("set", "viewport", "390", "844");
  await open(2, "Long");
  await check("on a phone the long branch wraps without horizontal scroll", noOverflow);
  await capture("mobile-long-branch");

  const errors = await browser("errors");
  assert.equal((Array.isArray(errors) ? errors : errors.errors ?? []).length, 0, `Unexpected browser errors: ${JSON.stringify(errors)}`);
  checks.push("browser console has no runtime errors");
  await writeFile(path.join(output, "results.json"), JSON.stringify({ base, checks, viewports: [[1440, 900], [390, 844]], browser: "agent-browser", deployment: "not tested" }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  for (const id of ids) await fetch(`${base}/api/handoffs/${id}`, { method: "DELETE", headers }).catch(() => {});
  const devices = await request("/api/devices").catch(() => ({ devices: [] }));
  for (const device of devices.devices ?? []) await fetch(`${base}/api/devices/${device.id}`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: device.version, connections: "unbind" }) }).catch(() => {});
  await browser("close").catch(() => {});
}
