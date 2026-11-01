// Browser acceptance for the connection lifecycle: row menu, extend, setup command, rotate and selection revoke.
// Runs against a built local Worker; every record belongs to a disposable owner and no secret is ever printed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5190";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Lifecycle browser checks require a local Worker.");
const run = crypto.randomUUID(), session = `agentrelay-lifecycle-${run.slice(0, 8)}`, output = path.resolve(`outputs/connection-lifecycle/${run}`);
const headers = { "oai-authenticated-user-id": `lifecycle-browser-${run}`, "oai-authenticated-user-email": "lifecycle@sites.test" }, checks = [];
await mkdir(output, { recursive: true });
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
async function browser(...args) {
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", error = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => error += chunk); child.on("error", reject);
    child.on("exit", code => {
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve(out); else reject(new Error(`Browser command failed (${args[0]} ${args[1] ?? ""}): ${error || out}`));
    });
  });
  const result = JSON.parse(raw); if (!result.success) throw new Error(result.error); return result.data;
}
const evalPage = async code => (await browser("eval", "-b", Buffer.from(code).toString("base64"))).result;
const check = async (name, expression) => { assert.equal(await evalPage(expression), true, name); checks.push(name); console.log(`PASS ${name}`); };
const click = selector => browser("click", selector);
const wait = expression => browser("wait", "--fn", expression);
const capture = name => browser("screenshot", path.join(output, name + ".png"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, method = "GET", data, extra = {}) {
  const response = await fetch(base + url, { method, headers: { ...headers, "Content-Type": "application/json", Connection: "close", ...extra }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20_000) });
  const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
}
const created = async (name, extra = {}) => { const result = await request("/api/agent-tokens", "POST", { name, ...extra }); assert.equal(result.status, 201); return result.data; };
// What an agent sends when it starts an MCP session; the page shows it next to the connection.
const initializeAs = (token, clientInfo) => fetch(base + "/api/agent/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Connection: "close" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo } }) });
const authenticates = async token => (await fetch(base + "/api/agent/connection", { headers: { Authorization: `Bearer ${token}`, Connection: "close" } })).status === 200;
// Rows are found by name, so their order and grouping do not matter. A row is centred first, so its menu opens in view. Menu items are Extend, Rotate, Setup in that order.
const inRow = (name, selector) => evalPage(`(() => { const row = [...document.querySelectorAll('.connection-row')].find(item => item.querySelector('strong')?.textContent === ${JSON.stringify(name)}); row.scrollIntoView({ block: 'center' }); row.querySelector(${JSON.stringify(selector)}).click(); return true; })()`);
const openMenu = name => inRow(name, ".menu-wrap .icon");

try {
  const alpha = await created("Alpha", { clientProfile: "codex" }), beta = await created("Beta", { clientProfile: "claude-code" }), gamma = await created("Gamma"), delta = await created("Delta");
  assert.equal((await initializeAs(alpha.token, { name: "codex", version: "0.9" })).status, 200);
  await browser("--headers", JSON.stringify(headers), "open", base); await browser("set", "viewport", "1440", "900");
  await wait("document.querySelector('.tabs [data-view=agent]') !== null"); await click('.tabs [data-view="agent"]');
  await wait("document.querySelectorAll('.connection-row').length === 4");

  await check("a row shows the agent chosen for it and what the agent reported", `(() => { const row = [...document.querySelectorAll('.connection-row')].find(item => item.querySelector('strong').textContent === 'Alpha'); return row.querySelector('.conn-client')?.textContent === 'Codex' && row.textContent.includes('Reports as codex 0.9'); })()`);
  await check("a connection without a profile or report has neither", `(() => { const row = [...document.querySelectorAll('.connection-row')].find(item => item.querySelector('strong').textContent === 'Gamma'); return !row.querySelector('.conn-client') && !row.textContent.includes('Reports as'); })()`);
  await click(".conn-segment button:nth-child(3)");
  await check("grouping by agent lists each profile, then the rest as other, without repeating the badge", "JSON.stringify([...document.querySelectorAll('.connection-group-head h3')].map(h => h.textContent)) === JSON.stringify(['Claude Code', 'Codex', 'Other or unknown']) && document.querySelectorAll('.conn-client').length === 0");
  await click(".conn-segment button:nth-child(2)");
  await check("the agent grouping survives switching back to devices", "document.querySelectorAll('.conn-client').length === 2 && document.querySelector('.conn-segment button[aria-pressed=true]').textContent === 'Device'");

  await openMenu("Alpha");
  await check("the row menu offers extend, rotate, setup and rename and focuses the first item", "[...document.querySelectorAll('.menu [role=menuitem]')].map(item => item.textContent).join('|') === 'Extend lifetime…|Rotate secret…|Show setup command…|Rename' && document.activeElement === document.querySelector('.menu [role=menuitem]')");
  await browser("press", "Escape");
  await check("Escape closes the menu and returns focus to its button", "!document.querySelector('.menu') && document.activeElement?.getAttribute('aria-haspopup') === 'menu'");

  await openMenu("Alpha"); await click(".menu [role=menuitem]:nth-child(1)");
  await wait("document.querySelector('dialog[open]') !== null");
  await check("extend opens a dialog starting on Cancel and defaulting to 90 days", "document.activeElement.textContent === 'Cancel' && document.querySelector('dialog[open] select').value === '90'");
  await browser("select", "dialog[open] select", "365"); await click("dialog[open] .primary");
  await wait("!document.querySelector('dialog[open]')");
  const extended = (await request("/api/agent-tokens")).data.tokens.find(t => t.id === alpha.id);
  assert.ok(extended.expiresAt - Date.now() > 364 * 86400000 && extended.version === alpha.version + 1); checks.push("extending applies the new lifetime"); console.log("PASS extending applies the new lifetime");
  await check("closing the dialog returns focus to the row menu button", "document.activeElement?.getAttribute('aria-haspopup') === 'menu'");

  await openMenu("Alpha"); await click(".menu [role=menuitem]:nth-child(3)");
  await wait("document.querySelector('dialog[open] pre.code') !== null");
  await check("the setup command starts on the agent the connection was made for", "document.querySelector('dialog[open] select').value === 'codex' && document.querySelector('dialog[open] pre.code').textContent.includes('--profile codex')");
  await check("the setup command names the connection and carries no secret", `(() => { const code = document.querySelector('dialog[open] pre.code').textContent; return code.includes('--connection ${alpha.id}') && !code.includes('agentrelay_'); })()`);
  await browser("select", "dialog[open] select", "claude-code");
  await check("choosing another agent changes the profile in the command", "document.querySelector('dialog[open] pre.code').textContent.includes('--profile claude-code')");
  await browser("press", "Escape"); await wait("!document.querySelector('dialog[open]')");

  await openMenu("Alpha"); await click(".menu [role=menuitem]:nth-child(2)");
  await wait("document.querySelector('dialog[open]') !== null");
  await check("rotate asks first, starting on Cancel, and has not changed anything yet", "document.activeElement.textContent === 'Cancel' && document.querySelector('dialog[open] .danger') !== null");
  assert.ok(await authenticates(alpha.token)); checks.push("the old secret still works before confirming"); console.log("PASS the old secret still works before confirming");
  await click("dialog[open] .danger"); await wait("document.querySelector('dialog[open] .connection-secret textarea') !== null");
  const secret = await evalPage("document.querySelector('dialog[open] .connection-secret textarea').value");
  assert.match(secret, /^agentrelay_[a-f0-9]{64}$/); checks.push("rotating shows the new secret once"); console.log("PASS rotating shows the new secret once");
  assert.equal(await authenticates(alpha.token), false); assert.equal(await authenticates(secret), true);
  checks.push("the old secret stops and the new one works"); console.log("PASS the old secret stops and the new one works");
  // Never retain the one-time secret in a screenshot, including a synthetic one.
  await evalPage("document.querySelector('dialog[open] .connection-secret textarea').style.visibility = 'hidden'; true");
  await capture("rotate-dialog");
  await browser("press", "Escape"); await wait("!document.querySelector('dialog[open]')");
  await pause(300);
  assert.equal(await evalPage(`document.body.innerText.includes(${JSON.stringify(secret)}) || document.documentElement.innerHTML.includes(${JSON.stringify(secret)})`), false);
  checks.push("closing the dialog removes the secret from the page"); console.log("PASS closing the dialog removes the secret from the page");
  await check("the rotated connection starts over as pending setup", `[...document.querySelectorAll('.connection-row')].find(row => row.querySelector('strong').textContent === 'Alpha').textContent.includes('Pending setup')`);

  await evalPage("document.querySelector('.token-tools .btn:first-child').click(); true"); await pause(400);
  const picks = await evalPage("[...document.querySelectorAll('.conn-check')].length");
  assert.equal(picks, 4);
  await inRow("Beta", ".conn-check"); await inRow("Gamma", ".conn-check");
  await check("selecting rows shows a count and a revoke action", "document.querySelector('.conn-selection')?.textContent.includes('2 selected') && !!document.querySelector('.conn-selection .danger')");
  await click(".conn-selection .danger"); await wait("document.querySelector('dialog[open]') !== null");
  await check("the selection preview lists exactly the chosen connections with Cancel focused", "document.querySelectorAll('dialog[open] li').length === 2 && document.activeElement.textContent === 'Cancel'");
  await click("dialog[open] .btn:not(.danger)"); await wait("!document.querySelector('dialog[open]')");
  await check("cancelling keeps the selection and revokes nothing", "document.querySelector('.conn-selection') !== null && document.activeElement === document.querySelector('.conn-selection .danger')");
  assert.ok((await request("/api/agent-tokens")).data.tokens.every(t => t.revokedAt === null)); checks.push("nothing was revoked by cancelling"); console.log("PASS nothing was revoked by cancelling");
  await click(".conn-selection .danger"); await click("dialog[open] .danger");
  await wait("document.querySelector('.inactive-connections') !== null");
  const after = (await request("/api/agent-tokens")).data.tokens;
  assert.deepEqual(after.filter(t => t.revokedAt).map(t => t.id).sort(), [beta.id, gamma.id].sort());
  assert.ok(after.filter(t => t.revokedAt).every(t => t.revokedReason === "bulk")); assert.ok(!after.find(t => t.id === delta.id).revokedAt);
  checks.push("confirming revokes exactly the selection with the bulk reason"); console.log("PASS confirming revokes exactly the selection with the bulk reason");
  await check("the selection clears once its connections are revoked", "document.querySelector('.conn-selection') === null");

  await evalPage("document.querySelector('.token-tools .btn:last-child').click(); true"); await wait("document.querySelectorAll('.activity-list li').length >= 8");
  await check("Activity lists the extension, rotation and set revocation", "(() => { const text = document.querySelector('.activity-list').textContent; return text.includes('extended Alpha') && text.includes('rotated the secret of Alpha') && text.includes('revoked all 2 active connections'); })()");
  await browser("press", "Escape"); await wait("!document.querySelector('dialog[open]')");

  await browser("set", "viewport", "390", "844");
  await openMenu("Delta");
  await check("the row menu fits a phone", "(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()");
  await capture("menu-mobile"); await browser("press", "Escape");
  await openMenu("Delta"); await click(".menu [role=menuitem]:nth-child(2)"); await wait("document.querySelector('dialog[open]') !== null");
  await check("the rotate dialog fits a phone", "(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()");
  await capture("rotate-mobile"); await browser("press", "Escape");
  const errors = await browser("errors"); assert.ok(!errors.errors?.length, "No browser runtime errors"); checks.push("no browser runtime errors");
} finally {
  await browser("press", "Escape").catch(() => {});
  for (const token of (await request("/api/agent-tokens")).data?.tokens ?? []) { await request(`/api/agent-tokens/${token.id}`, "DELETE"); await request(`/api/agent-tokens/${token.id}?permanent=1`, "DELETE"); }
  await writeFile(path.join(output, "browser-results.json"), JSON.stringify({ base, passed: checks.length, checks }, null, 2) + "\n");
  await browser("close").catch(() => {});
}
console.log(JSON.stringify({ passed: checks.length, output }));
