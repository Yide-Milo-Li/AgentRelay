// Browser acceptance for how a page reacts to its notification worker: the notice, the instant refresh, the answer that lets the
// worker skip a system notification, and opening a handoff from a clicked notification without reloading the tab.
// The worker's messages are delivered by hand because a real push needs Google's service; nothing here leaves the machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Notification browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `notify-browser-${run}`, session = `notify-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/notification-e2e/${run}`), headers = identityHeaders(owner, "notify@sites.test");
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
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
const checks = [];
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); console.log(`PASS ${name}`); }
async function request(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
}
const send = (title, target = "laptop") => request("/api/handoffs", "POST", { title, content: `# ${title}`, sourceDevice: "desktop", targetDevice: target, requestKey: crypto.randomUUID() });
/** Hand the page a message as the worker would, on a private channel, and return what the page answered on it. */
const deliver = data => evaluate(`(async () => {
  const channel = new MessageChannel(), answers = [];
  channel.port1.onmessage = event => answers.push(event.data);
  navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(data)}, ports: [channel.port2] }));
  await new Promise(resolve => setTimeout(resolve, 250));
  return JSON.stringify(answers);
})()`).then(JSON.parse);
const toast = "document.querySelector('.toast')";
const rowTitles = "[...document.querySelectorAll('.list .row strong')].map(node => node.textContent)";
const selectedTitle = "(document.querySelector('.detail-head h1')?.textContent ?? '')";

try {
  for (const name of ["Laptop", "Desktop"]) await request("/api/devices", "POST", { name });
  const first = await send("First task");
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "1000");
  await browser("set", "media", "light");
  await wait("document.querySelectorAll('.list .row').length === 1");
  await check("a browser that cannot use notifications loads the page quietly", `${rowTitles}.join('|') === 'First task' && !document.querySelector('[role=alert]')`);

  const second = await send("Second task");
  await check("the inbox has not noticed the new handoff yet", `${rowTitles}.length === 1`);
  const answers = await deliver({ type: "agentrelay.notification", eventId: "e1", title: "Second task", body: "Project", handoffId: second.id, gone: false, detail: "Second task" });
  assert.deepEqual(answers, [{ displayed: true }]); checks.push("the page answers that it displayed the notice"); console.log("PASS the page answers that it displayed the notice");
  await wait(`${toast} !== null`);
  await check("the notice names the handoff and offers to open it", `${toast}.textContent.includes('New handoff: Second task') && ${toast}.querySelector('.toast-action')?.textContent === 'Open'`);
  await wait("document.querySelectorAll('.list .row').length === 2");
  await check("the inbox refreshed at once instead of waiting for the next poll", `${rowTitles}.join('|') === 'Second task|First task'`);
  await capture("notice-en");
  await click(".toast-action");
  await wait(`${selectedTitle} === 'Second task'`);
  await check("opening from the notice selects that handoff and leaves the notice", `${selectedTitle} === 'Second task' && location.search === '?handoff=${second.id}' && !${toast}`);

  await deliver({ type: "agentrelay.notification", eventId: "e2", title: "AgentRelay", body: "gone", handoffId: first.id, gone: true, detail: null }).then(result => assert.deepEqual(result, [{ displayed: true }]));
  await check("a handoff that is already gone is acknowledged without a notice", `!${toast}`);
  await deliver({ type: "agentrelay.notification", eventId: "e3", title: "AgentRelay", body: "A handoff is waiting", handoffId: null, gone: false, detail: null });
  await check("a notice without a title still says a handoff is waiting", `${toast}?.textContent.includes('A new handoff is waiting') && !${toast}.querySelector('.toast-action')`);

  await evaluate("window.__sameDocument = true");
  const opened = await deliver({ type: "agentrelay.open-handoff", id: first.id });
  assert.deepEqual(opened, [{ handled: true }]); checks.push("the page answers that it opened the handoff"); console.log("PASS the page answers that it opened the handoff");
  await wait(`${selectedTitle} === 'First task'`);
  await check("a clicked notification selects its handoff without reloading the page", `${selectedTitle} === 'First task' && location.search === '?handoff=${first.id}' && window.__sameDocument === true`);

  // A handoff that is finished lives in the Done tab, which the page must switch to once it has read it.
  const finished = await send("Finished task");
  const claimed = await request(`/api/handoffs/${finished.id}`, "PATCH", { status: "claimed", device: "laptop", version: finished.version });
  await request(`/api/handoffs/${finished.id}`, "PATCH", { status: "done", version: claimed.version });
  assert.deepEqual(await deliver({ type: "agentrelay.open-handoff", id: finished.id }), [{ handled: true }]);
  await wait("document.querySelector('.tabs [aria-current=page]')?.dataset.view === 'done'");
  await wait(`${selectedTitle} === 'Finished task'`);
  await check("a handoff the page had not loaded is found and its tab is shown", `document.querySelector('.tabs [aria-current=page]').dataset.view === 'done' && ${selectedTitle} === 'Finished task'`);

  for (const data of [{ type: "agentrelay.open-handoff", id: "https://evil.example/" }, { type: "agentrelay.open-handoff" }, { type: "something.else" }]) {
    assert.deepEqual(await deliver(data), [], JSON.stringify(data));
  }
  await check("malformed or unknown messages are ignored and unanswered", `${selectedTitle} === 'Finished task'`);

  // Connection expiry reminders: the notice is the worker's own text, and it opens the connection list instead of a handoff.
  const reminder = "“Laptop agent” expires in 3 days. Renew it in AgentRelay.";
  assert.deepEqual(await deliver({ type: "agentrelay.notification", eventId: "r1", title: "Agent connection expiring", body: reminder, connectionId: crypto.randomUUID(), gone: false, detail: reminder }), [{ displayed: true }]);
  await wait(`${toast} !== null`);
  await check("an expiry reminder shows its text and offers the connection list", `${toast}.textContent.includes(${JSON.stringify(reminder)}) && ${toast}.querySelector('.toast-action')?.textContent === 'Open connections'`);
  await click(".toast-action");
  await check("opening from the reminder shows the Agents view", "document.querySelector('.tabs [aria-current=page]')?.dataset.view === 'agent'");
  await click(".tabs [data-view='inbox']");
  assert.deepEqual(await deliver({ type: "agentrelay.open-connections" }), [{ handled: true }]);
  await check("a clicked reminder shows the Agents view without reloading the page", "document.querySelector('.tabs [aria-current=page]')?.dataset.view === 'agent' && window.__sameDocument === true");
  // With no open tab the worker opens this address instead.
  await browser("open", `${base}/?view=agent`);
  await wait("document.querySelector('.tabs [aria-current=page]')?.dataset.view === 'agent'");
  await check("the reminder's address opens on the Agents view", "document.querySelector('.tabs [aria-current=page]').dataset.view === 'agent'");

  await click(".settings-button"); await click("[data-settings-section=general]"); await click(".lang-switch button[lang='zh-CN']");
  await click(".tabs [data-view='inbox']");
  await deliver({ type: "agentrelay.notification", eventId: "e4", title: "x", body: "y", handoffId: second.id, gone: false, detail: "第二个任务" });
  await wait(`${toast} !== null`);
  await check("the notice follows the interface language", `${toast}.textContent.includes('新交接：第二个任务') && ${toast}.querySelector('.toast-action').textContent === '查看'`);
  await capture("notice-zh");
  await browser("set", "viewport", "390", "800");
  await check("the notice fits a phone screen", `(() => { const box = ${toast}.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`);
  await capture("notice-phone");
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser("close").catch(() => {});
}
