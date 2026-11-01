// Run against a built local Worker with agent-browser installed; every record belongs to a disposable owner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5188";
if (!/^(127\.0\.0\.1|localhost)$/.test(new URL(base).hostname)) throw new Error("Device checks only run against a local Worker.");
const run = crypto.randomUUID();
const session = `agentrelay-devices-${run.slice(0, 8)}`;
const headers = { "oai-authenticated-user-id": `devices-qa-${run}`, "oai-authenticated-user-email": "devices@sites.test" };
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const output = path.resolve(process.env.AGENTRELAY_QA_OUTPUT ?? `outputs/devices-connections/${run}`);
const checks = [];
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
const capture = name => browser("screenshot", path.join(output, `${name}.png`));
// The language switch lives in Settings: switch there, then return to the view the page was on.
async function setLanguage(lang) {
  const view = await evaluate("document.querySelector('.tabs [aria-current=page]')?.dataset.view ?? ''");
  const storage = await evaluate("!!document.querySelector('.settings[data-section=storage]')");
  await click(".settings-button"); await click("[data-settings-section=general]"); await click(`.lang-switch button[lang="${lang}"]`);
  if (view) await click(`.tabs [data-view="${view}"]`); else if (storage) await click("[data-settings-section=storage]");
}
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
// Row lookups go through the page, because rows are identified by their visible device name.
const deviceRow = name => `[...document.querySelectorAll('.device-row')].find(row => row.querySelector('strong')?.textContent === ${JSON.stringify(name)} || row.querySelector('.device-rename')?.value === ${JSON.stringify(name)})`;
const inRow = (name, selector) => evaluate(`${deviceRow(name)}.querySelector(${JSON.stringify(selector)}).click(); true`);
const menuItem = (label) => evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
const rowExists = name => `!!(${deviceRow(name)})`;
const overflow = "document.documentElement.scrollWidth <= innerWidth";
// A toast from the previous step can sit over the controls at the bottom of a narrow page; dismiss it before clicking there.
// The device picker is a menu: open it, then pick an entry by its visible name.
async function openPicker() {
  await evaluate("document.querySelector('.device-pick[aria-expanded=false]')?.click(); true");
  await wait("document.querySelector('.device-menu') !== null");
}
async function pick(label) {
  await openPicker();
  await evaluate(`[...document.querySelectorAll('.device-menu [role^=menuitem]')].find(item => item.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
  await wait("document.querySelector('.device-menu') === null");
}
const unregisteredEntry = "document.querySelector('.device-menu-unregistered')";
const clearToast = () => evaluate("document.querySelector('.toast .icon')?.click(); true");

try {
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "900");
  // A new workspace opens on the setup checklist, whose first step asks which device this browser is.
  await wait("document.querySelector('.setup .setup-list') !== null");
  await check("a fresh browser has no device until it chooses one", "document.querySelector('.device-pick').dataset.unchosen === 'true' && localStorage.getItem('agentrelay.device.v2') === null && localStorage.getItem('agentrelay.device.v1') === null");

  // A name stored by the previous version is shown as unregistered, and offered first for registration.
  await evaluate("localStorage.setItem('agentrelay.device.v1', 'Build box'); localStorage.removeItem('agentrelay.device.v2'); true");
  await browser("reload");
  await wait("document.querySelector('.device-pick') !== null");
  await openPicker();
  await check("a stored v1 name that isn't registered is tagged not registered", `document.querySelector('.device-current').textContent === 'Build box' && ${unregisteredEntry}?.textContent.includes('Build box') && ${unregisteredEntry}.textContent.includes('not registered')`);
  await press("Escape");
  await click('.tabs [data-view="devices"]');
  await wait("document.querySelector('.device-onboarding') !== null");
  await check("onboarding offers the browser's own name first, then the common devices", "[...document.querySelectorAll('.device-onboarding .chips button:not(.quiet)')].map(b => b.textContent.trim()).join() === 'Build box,Laptop,Desktop,Phone' && !document.querySelector('.device-add') && document.querySelector('.device-onboarding .chips .quiet').textContent === 'Other…'");
  await check("the Devices tab is marked current and the view has a heading", "document.querySelector('.tabs [data-view=devices]').getAttribute('aria-current') === 'page' && document.querySelector('#devices-title').textContent === 'Your devices'");
  await capture("devices-onboarding");
  await click('.device-onboarding .chips button:nth-child(2)');
  await wait(rowExists("Laptop"));
  await check("a chip registers the device with its fixed id and colour", `${deviceRow("Laptop")}.querySelector('.id-chip code').textContent === 'laptop' && ${deviceRow("Laptop")}.dataset.line === 'amber'`);
  await check("the onboarding is replaced by the list once a device exists", "!document.querySelector('.device-onboarding') && document.querySelectorAll('.device-row').length === 1");

  // Earlier versions set every new browser to Laptop without asking; such a browser is asked once.
  await evaluate("localStorage.setItem('agentrelay.device.v1', 'Laptop'); localStorage.setItem('agentrelay.device.v2', 'laptop'); localStorage.removeItem('agentrelay.device.chosen.v1'); true");
  await browser("reload");
  await click('.tabs [data-view="inbox"]');
  await wait("document.querySelector('.device-guess') !== null");
  await check("a browser on an earlier version's unconfirmed Laptop guess is asked whether it is Laptop", "document.querySelector('.device-guess').textContent.includes('Is this browser Laptop?')");
  await click(".device-guess .link");
  await check("confirming keeps the device and stops asking", "!document.querySelector('.device-guess') && localStorage.getItem('agentrelay.device.chosen.v1') === '1' && localStorage.getItem('agentrelay.device.v2') === 'laptop'");
  await evaluate("localStorage.setItem('agentrelay.device.v1', 'Build box'); localStorage.removeItem('agentrelay.device.v2'); true");
  await browser("reload");
  await click('.tabs [data-view="devices"]');
  await wait("document.querySelector('.device-form') !== null");

  await fill(".device-form input:not(.mono)", "Build box");
  await check("the id follows the name until it is edited", "document.querySelector('.device-form input.mono').value === 'build-box'");
  await click(".device-form button.primary");
  await wait("document.querySelectorAll('.device-row').length === 2");
  await openPicker();
  await check("registering this browser's name links it without a reload", `${unregisteredEntry} === null && document.querySelector('.device-menu [aria-checked=true]').textContent.includes('Build box') && document.querySelector('.device-row[data-current] strong').textContent === 'Build box' && localStorage.getItem('agentrelay.device.v2') === 'build-box'`);
  await press("Escape");

  await fill(".device-form input:not(.mono)", "Work PC");
  await fill(".device-form input.mono", "wpc");
  await fill(".device-form input:not(.mono)", "Work PC two");
  await check("an edited id stays exactly as typed", "document.querySelector('.device-form input.mono').value === 'wpc'");
  await fill(".device-form input.mono", "Bad Id!");
  await check("an invalid id is flagged and blocks adding", "document.querySelector('.device-form input.mono').getAttribute('aria-invalid') === 'true' && document.querySelector('.device-form button.primary').disabled");
  await fill(".device-form input.mono", "wpc");
  await click(".device-form button.primary");
  await wait("document.querySelectorAll('.device-row').length === 3");
  await check("the typed id is what the server stored", `${deviceRow("Work PC two")}.querySelector('.id-chip code').textContent === 'wpc'`);
  await fill(".device-form input:not(.mono)", "work pc TWO");
  await click(".device-form button.primary");
  await wait("document.querySelector('.device-form [role=alert]') !== null");
  await check("a duplicate name shows the server's reason and keeps the form", "document.querySelector('.device-form [role=alert]').textContent.includes('already exists') && document.querySelectorAll('.device-row').length === 3");
  await fill(".device-form input:not(.mono)", "");
  await capture("devices-list");

  // Rename, recolour and copy an id.
  await inRow("Laptop", ".menu-wrap > button");
  await check("the row menu is a labelled shortcut layer", "document.querySelector('[role=menu]')?.hasAttribute('data-shortcut-layer') === true");
  await check("the active row elevates above subsequent rows", `${deviceRow("Laptop")}.hasAttribute('data-menu-open') && getComputedStyle(${deviceRow("Laptop")}).zIndex === '15'`);
  await menuItem("Rename");
  await fill(".device-rename", "Home laptop");
  await press("Enter");
  await wait(rowExists("Home laptop"));
  await check("renaming keeps the id", `${deviceRow("Home laptop")}.querySelector('.id-chip code').textContent === 'laptop'`);
  await inRow("Home laptop", ".device-dot");
  await click('.swatch[data-line="violet"]');
  await wait(`${deviceRow("Home laptop")}.dataset.line === 'violet'`);
  await check("recolouring changes the line colour and persists it", `${deviceRow("Home laptop")}.dataset.line === 'violet'`);
  assert.equal((await request("/api/devices")).devices.find(d => d.id === "laptop").line, "violet");
  checks.push("the new colour is stored on the server");
  await inRow("Home laptop", ".id-chip button");
  await wait("document.querySelector('.toast') !== null");
  await check("copying an id reports back", "document.querySelector('.toast').textContent.length > 0");

  // The picker, "This device" and Manage devices….
  await evaluate("document.querySelector('.toast .icon')?.click(); true");
  await pick("Home laptop");
  await wait("localStorage.getItem('agentrelay.device.v2') === 'laptop'");
  await check("choosing a device in the picker stores its id and keeps the v1 name in step", "localStorage.getItem('agentrelay.device.v2') === 'laptop' && localStorage.getItem('agentrelay.device.v1') === 'Home laptop'");
  await check("the current device is marked in the list", `${deviceRow("Home laptop")}.dataset.current === 'true'`);
  await click('.tabs [data-view="inbox"]');
  await pick("Manage devices…");
  await wait("document.querySelector('.tabs [data-view=devices]').getAttribute('aria-current') === 'page'");
  await check("Manage devices… opens the Devices tab and leaves the selection alone", "localStorage.getItem('agentrelay.device.v2') === 'laptop'");
  await inRow("Build box", ".btn.small");
  await check("Use on this browser switches the current device", "localStorage.getItem('agentrelay.device.v2') === 'build-box'");
  await pick("Home laptop");

  // Handoffs carry ids, and routes follow renames.
  await click(".new");
  await fill('[name="title"]', "Device route");
  await fill('[name="content"]', "route through the registry");
  await fill('[name="targetDevice"]', "build box");
  await click('button[type="submit"]');
  await wait("!document.querySelector('dialog[open]')");
  const created = (await request("/api/handoffs")).handoffs.find(row => row.title === "Device route");
  assert.ok(created && created.sourceDeviceId === "laptop" && created.targetDeviceId === "build-box", JSON.stringify(created));
  checks.push("the compose form sends registered devices by id");
  await click('.tabs [data-view="devices"]');
  await inRow("Build box", ".menu-wrap > button");
  await menuItem("Rename");
  await fill(".device-rename", "CI box");
  await press("Enter");
  await wait(rowExists("CI box"));
  await click('.tabs [data-view="inbox"]');
  await wait("document.querySelector('.row .route-name') !== null");
  await check("routes show the renamed device in the list and the detail", "[...document.querySelectorAll('.row .route-name')].some(el => el.textContent === 'CI box') && document.querySelector('.route-full li:last-child b').textContent === 'CI box'");
  assert.equal((await request("/api/handoffs")).handoffs.find(row => row.title === "Device route").targetDevice, "Build box");
  checks.push("the stored snapshot name is unchanged by a rename");
  await check("the filter lists registered devices by their current names", "[...document.querySelectorAll('select[aria-label=\"Filter by receiving device\"] option')].map(o => o.textContent).includes('CI box')");
  await capture("inbox-registry-routes");

  // Deleting the current device keeps its name as plain text and offers to re-register it.
  await click('.tabs [data-view="devices"]');
  await inRow("Home laptop", ".menu-wrap > button");
  await menuItem("Delete device");
  await wait("document.querySelector('.device-confirm') !== null && document.querySelector('.device-confirm p').textContent.includes('open handoff')");
  await check("the delete strip says how many handoffs use the device", "document.querySelector('.device-confirm p').textContent.includes('1 open handoff')");
  await capture("devices-delete-confirm");
  await click(".device-confirm .btn.danger");
  await wait(`!(${deviceRow("Home laptop")})`);
  await openPicker();
  await check("the deleted current device falls back to its name, marked not registered", `${unregisteredEntry}?.textContent.includes('Home laptop') && ${unregisteredEntry}.textContent.includes('not registered') && localStorage.getItem('agentrelay.device.v2') === ''`);
  await press("Escape");
  await wait("document.querySelector('.device-seen') !== null");
  await check("the name moves to Seen in handoffs", "[...document.querySelectorAll('.device-seen li span')].some(el => el.textContent === 'Home laptop')");
  assert.equal((await request("/api/handoffs")).handoffs.find(row => row.title === "Device route").sourceDeviceId, null);
  checks.push("the handoff lost its link but kept its source name");
  await click(".device-seen li .btn");
  await wait(rowExists("Home laptop"));
  await check("one click registers a seen name and relinks this browser", `${deviceRow("Home laptop")}.dataset.current === 'true' && !document.querySelector('.device-seen')`);

  // Connections: the wizard end to end.
  await click('.tabs [data-view="agent"]');
  await click(".new-connection");
  await wait("document.querySelector('.wizard') !== null");
  await check("the wizard opens on the device step with this browser's device chosen", "document.querySelector('#wizard-heading').textContent === 'Which device will use it?' && document.querySelector('.wizard input[name=connection-device]:checked').closest('label').textContent.includes('Home laptop') && !document.querySelector('.wizard input[name=connection-client]') && document.querySelector('.wizard-steps li[aria-current=step]').textContent.includes('Device')");
  await capture("connection-wizard-device");
  await click(".wizard-actions .btn.primary");
  await check("the agent step offers only agents and defaults to Claude Code", "document.querySelector('#wizard-heading').textContent === 'Which agent will connect?' && document.querySelector('.wizard input[name=connection-client]:checked').closest('label').textContent.startsWith('Claude Code') && !document.querySelector('.wizard input[name=connection-device]')");
  await check("a finished step shows what it settled", "document.querySelector('.wizard-steps li[data-state=done] small').textContent === 'Home laptop'");
  await click(".wizard-steps li[data-state=done] button");
  await check("a finished step can be reopened before the token exists", "document.querySelector('#wizard-heading').textContent === 'Which device will use it?'");
  await click(".wizard-actions .btn.primary");
  await click(".wizard-actions .btn.primary");
  await check("the details step names the connection after device and agent and defaults to 90 days", "document.querySelector('#wizard-heading').textContent === 'Name and lifetime' && document.querySelector('.wizard .field input').value === 'Home laptop · Claude Code' && document.querySelector('.wizard select').value === '90'");
  await check("the details step identifies the credential store and local files", "document.querySelector('.wizard-note').textContent.includes('credential store')");
  await capture("connection-wizard-details");
  await click(".wizard-actions .btn.primary");
  await wait("document.querySelector('.connection-secret') !== null");
  await check("issuing locks the earlier steps", "!document.querySelector('.wizard-steps button') && document.querySelectorAll('.wizard-steps li[data-state=done]').length === 3");
  await check("the verification step shows the one-time token", "/^agentrelay_[a-f0-9]{64}$/.test(document.querySelector('.connection-secret textarea').value)");
  // A device's first connection starts with saving the Site's gateway token, so the command is the second panel.
  await check("a device's first connection saves the gateway token before the command", "document.querySelector('.setup-gateway-first') !== null && document.querySelector('.connection-secret .setup-steps > li:nth-child(2) pre').textContent.includes('agentrelay.mjs connect')");
  await check("the command uses a connection reference and carries no token", "(() => { const code = [...document.querySelectorAll('.connection-secret .panel pre')].map(pre => pre.textContent).find(text => text.includes('agentrelay.mjs connect')); return code.includes('agentrelay.mjs connect --profile claude-code --device home-laptop --connection ') && !code.includes('agentrelay_'); })()");
  await check("authentication is explicitly distinct from an online agent", "document.querySelector('.connection-verification').textContent.includes('not that the agent is running')");
  // Never retain the one-time credential in a screenshot, including synthetic test credentials.
  await evaluate("document.querySelector('.connection-secret textarea').style.visibility='hidden'; true");
  await capture("connection-verification");
  await click(".secret-actions .link");
  await check("hiding the token keeps the command and the status", "!document.querySelector('.connection-secret textarea') && document.querySelector('.connection-secret .panel pre') !== null && document.querySelector('.connection-verification') !== null");
  await click(".connection-verification .btn.primary");
  await wait("document.querySelector('.wizard') === null");
  await check("the new connection is listed under its device without repeating it", "document.querySelector('.connection-group h3').textContent === 'Home laptop' && document.querySelector('.connection-row strong').textContent === 'Claude Code' && document.querySelector('.connection-row strong').title === 'Home laptop · Claude Code'");

  assert.equal((await request("/api/agent-tokens")).tokens[0].clientProfile, "claude-code"); checks.push("the wizard records the agent it was run for"); console.log("PASS the wizard records the agent it was run for");
  await check("the row whose title already names the agent does not repeat it as a badge", "document.querySelector('.connection-row .conn-client') === null");
  await check("the row carries its device as a coloured tag", "document.querySelector('.connection-row .device-chip')?.dataset.line === document.querySelector('.connection-group').dataset.line");

  await check("the row keeps its facts on one meta line and its notes behind the information button", "document.querySelectorAll('.connection-row .connection-meta span').length >= 2 && !document.querySelector('.tokens > p.muted') && !!document.querySelector('.tokens-head .info-tip-trigger')");
  // Rename is rare, so it lives in the row's More menu next to extend, rotate and setup.
  await evaluate("document.querySelector('.connection-row .menu-wrap .icon').click(); true");
  await menuItem("Rename");
  await fill(".device-rename", "Daily driver");
  await press("Enter");
  await wait("document.querySelector('.connection-row strong')?.textContent === 'Daily driver'");
  await browser("select", ".connection-row select", "CI box");
  await wait("document.querySelector('.connection-group h3')?.textContent === 'CI box'");
  await check("renaming and moving a connection update the list", "document.querySelector('.connection-row strong').textContent === 'Daily driver' && document.querySelector('.connection-group h3').textContent === 'CI box'");
  await check("a custom name brings the agent badge back", "document.querySelector('.connection-row .conn-client')?.textContent === 'Claude Code'");
  assert.equal((await request("/api/agent-tokens")).tokens[0].deviceId, "build-box");
  checks.push("the new binding is stored");
  // The Devices view counts a device's connections and opens the connection list narrowed to it.
  await click(".tabs [data-view=devices]");
  await wait("document.querySelector('.device-row .device-meta .link') !== null");
  await check("a device row shows how many connections use it", "[...document.querySelectorAll('.device-row')].filter(row => row.querySelector('.device-meta .link')?.textContent === '1 connection').length === 1");
  await capture("devices-connection-link");
  await click(".device-row .device-meta .link");
  await wait("document.querySelector('.conn-toolbar') !== null");
  await check("its link opens the connection list narrowed to that device", "[...document.querySelectorAll('.conn-filter select')].some(select => select.value === 'build-box') && document.querySelectorAll('.connection-row').length === 1");
  await click(".tabs [data-view=devices]");
  await click(".tabs [data-view=agent]");
  await check("opening Agents from its tab starts with no device filter", "[...document.querySelectorAll('.conn-filter select')].every(select => select.value === 'all')");
  await check("the revoked section does not exist while nothing is revoked", "!document.querySelector('.inactive-connections')");
  await evaluate("[...document.querySelectorAll('.connection-actions .btn')].find(b => b.textContent === 'Revoke').click(); true");
  await wait("document.querySelector('.connection-row .confirm') !== null");
  await click(".connection-row .confirm .btn.danger");
  await wait("document.querySelector('.inactive-connections') !== null");
  await check("revoked connections move into a collapsed section", "document.querySelector('.inactive-connections summary').textContent === 'Revoked & expired (1)' && document.querySelector('.inactive-connections').open === false && !document.querySelector('.connection-row')");
  await capture("connections-revoked-collapsed");
  await click(".inactive-connections summary");
  await click(".inactive-connections .token-row .btn.small");
  await wait("document.querySelector('.inactive-connections .token-row .confirm') !== null");
  await click(".inactive-connections .token-row .confirm .btn.danger");
  await wait("document.querySelector('.inactive-connections') === null");
  assert.equal((await request("/api/agent-tokens")).tokens.length, 0);
  checks.push("removing a revoked connection deletes it on the server");

  // Language switching never renames anything.
  await click('.tabs [data-view="devices"]');
  const namesBefore = await evaluate("JSON.stringify([...document.querySelectorAll('.device-row strong')].map(el => el.textContent))");
  await setLanguage("zh-CN");
  await wait("document.documentElement.lang === 'zh-CN'");
  await check("Chinese labels the tab and the view", "document.querySelector('.tabs [data-view=devices]').textContent.trim() === '设备' && document.querySelector('#devices-title').textContent === '我的设备'");
  await check("switching language leaves device names alone", `JSON.stringify([...document.querySelectorAll('.device-row strong')].map(el => el.textContent)) === ${JSON.stringify(namesBefore)}`);
  assert.deepEqual((await request("/api/devices")).devices.map(d => d.name).sort(), JSON.parse(namesBefore).sort());
  checks.push("the registry on the server is unchanged by the language switch");
  await capture("devices-chinese");
  await click('.tabs [data-view="agent"]');
  await click(".new-connection");
  await check("the wizard is translated", "document.querySelector('#wizard-heading').textContent === '哪台设备使用？'");
  await capture("connection-wizard-chinese");
  await clearToast();
  await click(".wizard-actions .btn:not(.primary)");
  await setLanguage("en");

  // Narrow and dark.
  await browser("set", "viewport", "390", "844");
  await click('.tabs [data-view="devices"]');
  await check("Devices has no horizontal overflow at 390px", overflow);
  await check("the four tabs live in a strip that scrolls sideways instead of widening the page", "getComputedStyle(document.querySelector('.tabs')).overflowX === 'auto' && document.querySelector('.tabs').scrollWidth <= document.querySelector('.tabs').parentElement.scrollWidth");
  await capture("devices-mobile");
  await inRow("Home laptop", ".menu-wrap > button");
  await check("the row menu stays inside the viewport", "document.querySelector('.menu').getBoundingClientRect().right <= innerWidth + 1 && document.querySelector('.menu').getBoundingClientRect().left >= 0");
  await press("Escape");
  await click('.tabs [data-view="agent"]');
  await click(".new-connection");
  await check("the wizard has no horizontal overflow at 390px", overflow);
  await capture("connection-wizard-mobile");
  await clearToast();
  await click(".wizard-actions .btn:not(.primary)");
  await browser("set", "media", "dark", "reduced-motion");
  await click('.tabs [data-view="devices"]');
  await check("dark mode keeps the registry free of overflow", overflow);
  await capture("devices-mobile-dark");
  await browser("set", "viewport", "1440", "900");
  await capture("devices-desktop-dark");
  await browser("set", "media", "light");
  const errors = await browser("errors");
  assert.ok(!errors.errors?.length, JSON.stringify(errors));
  checks.push("no browser runtime errors");
} finally {
  const { handoffs } = await request("/api/handoffs");
  for (const row of handoffs) await request(`/api/handoffs/${row.id}`, "DELETE");
  for (const token of (await request("/api/agent-tokens")).tokens) {
    await request(`/api/agent-tokens/${token.id}`, "DELETE");
    await request(`/api/agent-tokens/${token.id}?permanent=1`, "DELETE");
  }
  for (const device of (await request("/api/devices")).devices) await request(`/api/devices/${device.id}`, "DELETE", { version: device.version });
  await writeFile(path.join(output, "browser-results.json"), JSON.stringify({ base, passed: checks.length, checks }, null, 2) + "\n");
  await browser("close");
}
console.log(JSON.stringify({ passed: checks.length, output }, null, 2));
