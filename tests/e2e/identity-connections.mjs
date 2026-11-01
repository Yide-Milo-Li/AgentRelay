// Browser acceptance uses an isolated synthetic owner and never records a visible token.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5190";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Identity browser checks require a local Worker.");
const run = crypto.randomUUID(), session = `agentrelay-identity-${run.slice(0, 8)}`, output = path.resolve(`outputs/identity-connections/${run}`);
const headers = { "oai-authenticated-user-id": `identity-browser-${run}`, "oai-authenticated-user-email": "tester@sites.test" }, checks = [];
await mkdir(output, { recursive: true });
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
async function browser(...args) {
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", error = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => error += chunk); child.on("error", reject);
    child.on("exit", code => { child.stdout.destroy(); child.stderr.destroy(); code === 0 ? resolve(out) : reject(new Error(`Browser command failed (${args[0]} ${args[1] ?? ""}): ${error || out}`)); });
  });
  const result = JSON.parse(raw); if (!result.success) throw new Error(result.error); return result.data;
}
const evalPage = async code => (await browser("eval", "-b", Buffer.from(code).toString("base64"))).result;
const check = async (name, expression) => { assert.equal(await evalPage(expression), true, name); checks.push(name); console.log(`PASS ${name}`); };
// The language switch lives in Settings: switch there, then return to the view the page was on.
async function setLanguage(lang) {
  const view = await evalPage("document.querySelector('.tabs [aria-current=page]')?.dataset.view ?? ''");
  const storage = await evalPage("!!document.querySelector('.settings[data-section=storage]')");
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(`.lang-switch button[lang="${lang}"]`);
  if (view) await click(`.tabs [data-view="${view}"]`); else if (storage) await click("[data-settings-section=storage]");
}
const click = selector => browser("click", selector);
async function select(value) {
  await browser("select", ".wizard select", value);
  if (value === "permanent") await browser("wait", "--fn", "(() => { const d=document.querySelector('.identity-dialog[open]'),b=d?.querySelector('button');if(!b)return false;const r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b; })()");
}
const wait = expression => browser("wait", "--fn", expression);
// Device and agent come first; the lifetime lives on the third step. Each pane rises in, so click once it has settled.
const settled = field => `!!document.querySelector('.wizard input[name=${field}]') && document.querySelector('.wizard').getAnimations({ subtree: true }).every(a => a.playState === 'finished')`;
async function toDetails() {
  // This browser has no device, so the wizard preselects none: "No device" is chosen on purpose.
  await wait(settled("connection-device"));
  await check("the device step waits for a choice when this browser has no device", "document.querySelector('.wizard-actions .primary').disabled && !document.querySelector('.wizard input[name=connection-device]:checked')");
  await click(".wizard input[name=connection-device]"); await click(".wizard-actions .primary");
  await wait(settled("connection-client")); await click(".wizard-actions .primary");
  await wait("document.querySelector('.wizard select') !== null");
}
const capture = name => browser("screenshot", path.join(output, name + ".png"));
async function request(url, method = "GET", data) {
  const response = await fetch(base + url, { method, headers: { ...headers, "Content-Type": "application/json", Connection: "close" }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `Test fixture ${method} ${url}: ${response.status}`); return response.json();
}
try {
  await request("/api/devices", "POST", { name: "Desk", id: "desk" });
  await browser("--headers", JSON.stringify(headers), "open", base); await browser("set", "viewport", "1440", "900");
  await browser("snapshot", "-i"); await click('.tabs [data-view="agent"]'); await click(".new-connection");
  await toDetails();
  await check("lifetime defaults to 90 days", "document.querySelector('.wizard select').value === '90'");
  await select("permanent"); await wait("document.querySelector('.identity-dialog[open]') !== null");
  await check("permanent risk modal starts on Cancel and names revocation", "document.activeElement.textContent === 'Cancel' && document.querySelector('#permanent-risk').textContent.includes('until you revoke')");
  assert.equal((await request("/api/agent-tokens")).tokens.length, 0); checks.push("choosing permanent issues no credential");
  await capture("permanent-risk-desktop"); await browser("press", "Escape");
  await check("Escape restores 90 days and select focus", "!document.querySelector('.identity-dialog[open]') && document.querySelector('.wizard select').value === '90' && document.activeElement === document.querySelector('.wizard select')");
  await select("permanent"); await browser("mouse", "move", "1", "1"); await browser("mouse", "down"); await browser("mouse", "up");
  await check("backdrop cancellation preserves the previous choice", "!document.querySelector('.identity-dialog[open]') && document.querySelector('.wizard select').value === '90'");
  await select("30"); await select("permanent"); await click(".identity-dialog[open] .btn:not(.danger)");
  await check("Cancel restores the prior 30 day choice", "document.querySelector('.wizard select').value === '30'");
  await select("permanent"); await browser("press", "Tab"); await browser("press", "Enter");
  await check("risk confirmation only selects permanent", "document.querySelector('.wizard select').value === 'permanent'");
  assert.equal((await request("/api/agent-tokens")).tokens.length, 0);
  await select("365"); await select("permanent");
  await check("selecting permanent again asks for fresh acknowledgement", "!!document.querySelector('.identity-dialog[open]')");
  await browser("press", "Escape");
  await browser("set", "viewport", "390", "844"); await setLanguage("zh-CN"); await click(".new-connection");
  await toDetails(); await select("permanent");
  await check("Chinese risk copy fits at 390 px with Cancel focused", "document.querySelector('#permanent-title').textContent === '使用永久连接？' && document.activeElement.textContent === '取消' && document.documentElement.scrollWidth <= innerWidth && document.querySelector('.identity-dialog').getBoundingClientRect().right <= innerWidth");
  await capture("permanent-risk-mobile-zh"); await click(".identity-dialog[open] .danger");
  await click(".wizard-actions .primary");
  await wait("document.querySelector('.connection-secret') !== null");
  const issued = (await request("/api/agent-tokens")).tokens;
  assert.equal(issued.length, 1); assert.equal(issued[0].neverExpires, true); assert.equal(issued[0].expiresAt, null);
  checks.push("only the final Create issues one permanent connection");
  // The filter toolbar (and with it the member grouping) appears once there are more than three connections.
  for (const name of ["Spare 1", "Spare 2", "Spare 3"]) await request("/api/agent-tokens", "POST", { name, expiresInDays: 30 });
  await check("verification distinguishes authentication from agent presence", "document.querySelector('.connection-verification').textContent.includes('不代表 Agent 正在运行')");
  await click(".connection-verification .btn.primary"); await click(".token-tools .btn:first-child"); await wait("document.querySelectorAll('.connection-row').length === 4");
  await check("active permanent is labelled revocable", "[...document.querySelectorAll('.connection-row')].some(row => row.textContent.includes('永久 · 可撤销'))");
  await check("a never-used connection says so and shows a status", "document.querySelector('.connection-row').textContent.includes('从未使用') && !!document.querySelector('.conn-status')");
  await click(".conn-segment button:first-child"); await wait("document.querySelector('.connection-group-head .btn') !== null");
  await click(".connection-group-head .btn"); await wait("document.querySelector('dialog[open]') !== null");
  await check("issuer revocation previews the exact set with Cancel focused", "document.querySelectorAll('.identity-dialog li').length === 4 && [...document.querySelectorAll('.identity-dialog li')].some(li => li.textContent.includes('永久')) && document.activeElement.textContent === '取消'");
  await click(".identity-dialog[open] .btn:not(.danger)");
  await check("issuer preview cancellation restores trigger focus", "document.activeElement === document.querySelector('.connection-group-head .btn')");
  await click(".connection-group-head .btn"); await click(".identity-dialog[open] .danger");
  await wait("document.querySelector('.inactive-connections') !== null");
  assert.ok((await request("/api/agent-tokens")).tokens.every(token => token.revokedAt)); checks.push("issuer revocation retires every active connection of the issuer");
  await check("Agent view has no horizontal overflow at 390 px", "document.documentElement.scrollWidth <= innerWidth");
  await capture("connections-mobile-zh");
  await setLanguage("en");
  await click(".settings-button");
  await check("workspace account and device have separate labels", "document.querySelector('#setting-workspace').parentElement.textContent.includes('Personal workspace') && document.querySelector('#setting-workspace').parentElement.textContent.includes('Signed in as') && document.querySelector('#setting-workspace').parentElement.textContent.includes('Current device')");
  const errors = await browser("errors"); assert.ok(!errors.errors?.length, "No browser runtime errors"); checks.push("no browser runtime errors");
} finally {
  await browser("press", "Escape").catch(() => {});
  const tokens = (await request("/api/agent-tokens")).tokens;
  for (const token of tokens) { await request(`/api/agent-tokens/${token.id}`, "DELETE"); await request(`/api/agent-tokens/${token.id}?permanent=1`, "DELETE"); }
  const devices = (await request("/api/devices")).devices;
  for (const device of devices) await request(`/api/devices/${device.id}`, "DELETE", { version: device.version });
  await writeFile(path.join(output, "browser-results.json"), JSON.stringify({ base, passed: checks.length, checks }, null, 2) + "\n");
  await browser("close").catch(() => {});
}
console.log(JSON.stringify({ passed: checks.length, output }));
