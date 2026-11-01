// Browser acceptance for project organization: inbox tags and filter, the compose project picker and the detail tag.
// Uses a disposable owner on the built local Worker, never a live Site.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Project browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `projects-browser-${run}`, session = `projects-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/projects-e2e/${run}`), headers = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": "projects@sites.test" };
const localState = process.env.AGENTRELAY_TEST_STATE ?? ".wrangler/state";
const localConfig = process.env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json";
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
const checks = [];
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
const fill = (selector, value) => browser("fill", selector, value);
const wait = expression => browser("wait", "--fn", expression);
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
const sql = command => execFileSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local",
  "--config", localConfig, "--persist-to", localState, "--command", command], { stdio: "pipe", windowsHide: true });
const send = (title, project, status) => request("/api/handoffs", "POST", { title, content: `# ${title}`, sourceDevice: "laptop", targetDevice: "desktop", requestKey: crypto.randomUUID(), ...(project ? { project } : {}) })
  .then(async row => status === "done" ? request(`/api/handoffs/${row.id}`, "PATCH", { status: "done", version: (await request(`/api/handoffs/${row.id}`, "PATCH", { status: "claimed", device: "desktop", version: 1 })).version }) : row);
const rowTitles = "[...document.querySelectorAll('.list .row strong')].map(node => node.textContent)";
const filterSelect = "select[aria-label='Filter by project']";

try {
  for (const name of ["Laptop", "Desktop"]) await request("/api/devices", "POST", { name });
  // Oldest first, so the inbox (newest first) starts with the legacy row.
  await send("Agent relay first", "AgentRelay");
  await send("Agent relay second", "agent-relay");
  await send("Web app task", "web-app");
  await send("Loose task");
  await send("Docs finished", "docs-site", "done");
  const legacy = await send("Legacy task");
  sql(`UPDATE handoffs SET project = 'Agent Relay', project_id = NULL WHERE owner_id = '${owner}' AND id = '${legacy.id}';`);

  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "1000");
  await browser("set", "media", "light");
  // Sending needs this browser to know which device it is; a new browser has none until it chooses.
  await evaluate("localStorage.setItem('agentrelay.device.v2', 'laptop'); localStorage.setItem('agentrelay.device.chosen.v1', '1'); true");
  await browser("reload");
  await wait("document.querySelectorAll('.list .row').length === 5");
  await wait(`document.querySelector("${filterSelect}")?.options.length >= 4`);

  // Inbox tags: every spelling shows the stored project name and its swatch; a row without a project shows none.
  await check("rows show one project tag per filed handoff", "[...document.querySelectorAll('.list .row')].map(row => row.querySelector('.project-tag')?.textContent ?? '').join('|') === 'AgentRelay||web-app|AgentRelay|AgentRelay'");
  await check("the legacy row is filed under the existing project", "document.querySelector('.list .row .project-tag').textContent === 'AgentRelay'");
  await check("project swatches are square and coloured", "(() => { const swatch = document.querySelector('.list .project-tag i'); const style = getComputedStyle(swatch); return parseFloat(style.borderRadius) <= 2 && style.backgroundColor !== 'rgba(0, 0, 0, 0)'; })()");
  await check("the filter lists projects by last use with inbox counts, and no project last", `[...document.querySelector("${filterSelect}").options].map(option => option.textContent).join('|') === 'All projects|docs-site (0)|web-app (1)|AgentRelay (3)|No project (1)'`);
  await check("the dropdowns and the manage button stay together on one line at the right", "(() => { const [device, project] = [...document.querySelectorAll('.filters select')].map(select => select.getBoundingClientRect()); const manage = document.querySelector(\"button[aria-label='Manage projects']\").getBoundingClientRect(); const pane = document.querySelector('.list-tools').getBoundingClientRect(); return Math.abs(device.top - project.top) < 2 && Math.abs(manage.top + manage.height / 2 - (project.top + project.height / 2)) < 3 && manage.left >= project.right && manage.right <= pane.right && pane.right - manage.right < 24; })()");
  await capture("desktop-inbox");

  const agentId = (await request("/api/projects")).projects.find(project => project.name === "AgentRelay").id;
  await browser("select", filterSelect, `p:${agentId}`);
  await check("filtering by project keeps only its handoffs", `${rowTitles}.join('|') === 'Legacy task|Agent relay second|Agent relay first'`);
  await browser("select", filterSelect, "none");
  await check("filtering by no project keeps unfiled handoffs", `${rowTitles}.join('|') === 'Loose task'`);
  await browser("select", filterSelect, "all");
  await click("[data-view=done]");
  await wait("document.querySelectorAll('.list .row').length === 1");
  await check("the Done tab counts its own handoffs", `[...document.querySelector("${filterSelect}").options].map(option => option.textContent).join('|') === 'All projects|docs-site (1)|web-app (0)|AgentRelay (0)'`);
  await check("the detail footer shows the project tag", "document.querySelector('.detail-foot .project-tag')?.textContent === 'docs-site'");
  await click("[data-view=inbox]");
  await wait("document.querySelectorAll('.list .row').length === 5");

  // Compose: no project by default; typing matches by key; a new name offers creation.
  await click("button.new");
  await wait("document.querySelector('.compose [name=project]') !== null");
  await check("compose starts with no project", "document.querySelector('.compose [name=project]').value === '' && document.querySelector('.compose .project-input').hasAttribute('data-empty')");
  await click(".compose [name=project]");
  await check("the idle picker lists No project first, checked, then projects by last use", "[...document.querySelectorAll('.project-menu [role=option]')].map(option => option.textContent).join('|') === 'No project|docs-site|web-app|AgentRelay' && document.querySelector('.project-menu [role=option]').getAttribute('aria-selected') === 'true'");
  await capture("compose-picker");
  await fill(".compose [name=project]", "web app");
  await check("typing a variant selects the existing project and offers no creation", "[...document.querySelectorAll('.project-menu [role=option]')].map(option => option.textContent).join('|') === 'web-app' && document.querySelector('.project-menu [aria-selected=true]') !== null && !document.querySelector('.compose .field-note')");
  await fill(".compose [name=title]", "Typed variant");
  await check("blur replaces the variant with the stored name", "document.querySelector('.compose [name=project]').value === 'web-app'");
  await fill(".compose [name=project]", "Brand  New");
  await check("a new name offers creation and explains it", "document.querySelector('.project-menu-create')?.textContent === 'Create project “Brand New”' && document.querySelector('.compose .field-note') !== null && document.querySelector('.compose .project-input').hasAttribute('data-new')");
  await capture("compose-create");
  await click(".project-menu-create");
  await check("choosing creation keeps the cleaned name", "document.querySelector('.compose [name=project]').value === 'Brand New'");
  await fill(".compose textarea[name=content]", "# Brand new work");
  await click(".compose button[type=submit]");
  await wait("!document.querySelector('dialog.compose[open]') && document.querySelectorAll('.list .row').length === 6");
  const created = (await request("/api/handoffs")).handoffs.find(row => row.title === "Typed variant");
  assert.ok(created.projectId && created.project === "Brand New"); checks.push("sending creates the project and files the handoff"); console.log("PASS sending creates the project and files the handoff");
  await wait(`[...document.querySelector("${filterSelect}").options].some(option => option.textContent === 'Brand New (1)')`);
  await check("the new project appears in the filter and on its row", "document.querySelector('.list .row .project-tag').textContent === 'Brand New'");

  await click("button.new");
  await wait("document.querySelector('.compose [name=project]') !== null");
  await fill(".compose [name=title]", "Nothing to file");
  await fill(".compose textarea[name=content]", "No project here");
  await click(".compose button[type=submit]");
  await wait("!document.querySelector('dialog.compose[open]') && document.querySelectorAll('.list .row').length === 7");
  assert.equal((await request("/api/handoffs")).handoffs.find(row => row.title === "Nothing to file").project, ""); checks.push("an untouched picker sends no project"); console.log("PASS an untouched picker sends no project");

  // Chinese labels, dark mode and a phone-sized viewport.
  await setLanguage("zh-CN");
  await wait("document.documentElement.lang === 'zh-CN'");
  await check("the Chinese filter labels follow the language and keep project names", "(() => { const options = [...document.querySelector('select[aria-label=\"按项目筛选\"]').options].map(option => option.textContent); return options[0] === '全部项目' && options.includes('AgentRelay（3）') && options.at(-1) === '未分类（2）'; })()");
  await browser("set", "media", "dark"); await capture("desktop-dark-zh");
  await browser("set", "media", "light");
  await browser("set", "viewport", "390", "844");
  await wait("innerWidth === 390");
  // Sending opens the new handoff, which on a phone replaces the list.
  if (await evaluate("!!document.querySelector('.workspace.show-detail')")) await click(".detail-pane .back");
  await wait("!document.querySelector('.workspace.show-detail')");
  await check("the phone layout does not scroll sideways and keeps both filters visible", "document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.filters select')].every(select => { const box = select.getBoundingClientRect(); return box.right <= innerWidth && box.width > 0; })");
  await capture("mobile-zh");
  await setLanguage("en");
  await wait("document.documentElement.lang === 'en'");
  await browser("set", "viewport", "1440", "1000");
  await wait("innerWidth === 1440");

  // Manage projects: rename, archive, merge and delete, each reflected in the inbox.
  const projectId = async name => (await request("/api/projects")).projects.find(project => project.name === name).id;
  const rowTag = title => `([...document.querySelectorAll('.list .row')].find(row => row.querySelector('strong').textContent === ${JSON.stringify(title)})?.querySelector('.project-tag')?.textContent ?? '')`;
  const menuItem = (name, index) => `.project-row:has([aria-label=${JSON.stringify(`Actions for ${name}`)}]) [role=menuitem]:nth-child(${index})`;
  const openMenu = name => click(`[aria-label=${JSON.stringify(`Actions for ${name}`)}]`);
  const manageNames = "[...document.querySelectorAll('.project-manage .project-row strong')].map(node => node.textContent).join('|')";
  await click("button[aria-label='Manage projects']");
  await wait("document.querySelector('dialog.project-manage[open]') !== null");
  await check("the dialog lists every project with its loaded handoffs, close button focused", `${manageNames} === 'Brand New|docs-site|web-app|AgentRelay' && [...document.querySelectorAll('.project-manage .project-count')].map(node => node.textContent).join('|') === '1 handoff|1 handoff|1 handoff|3 handoffs' && document.activeElement.matches('.project-manage .compose-head .icon')`);
  await capture("manage-dialog");

  await openMenu("web-app"); await click(menuItem("web-app", 1));
  await fill(".project-manage .device-rename", "Web App 2"); await browser("press", "Enter");
  await wait(`${rowTag("Web app task")} === 'Web App 2'`);
  await check("rename shows in the dialog and on the inbox rows", `${manageNames}.includes('Web App 2') && ${rowTag("Typed variant")} === 'Brand New'`);

  await openMenu("docs-site"); await click(menuItem("docs-site", 3));
  await wait("document.querySelector('.project-list-heading')?.textContent === 'Archived'");
  await check("an archived project moves to the archived list and leaves the inbox filter", `[...document.querySelectorAll('.project-manage .project-list')].at(-1).textContent.includes('docs-site') && ![...document.querySelector("${filterSelect}").options].some(option => option.textContent.startsWith('docs-site'))`);

  await openMenu("Brand New"); await click(menuItem("Brand New", 2));
  await wait("document.querySelector('.project-confirm select') !== null");
  await check("the merge panel explains what moves and focuses the target", "document.activeElement.matches('.project-confirm select') && document.querySelector('.project-confirm p').textContent === 'Its 1 handoff moves to the chosen project, and “Brand New” is deleted.'");
  await browser("select", ".project-confirm select", await projectId("AgentRelay"));
  await capture("manage-merge");
  await click(".project-confirm .btn.danger");
  await wait(`${rowTag("Typed variant")} === 'AgentRelay'`);
  await check("merge removes the project and refiles its handoffs", `!${manageNames}.includes('Brand New') && document.activeElement.matches('.project-manage .compose-head .icon')`);

  await openMenu("Web App 2"); await click(menuItem("Web App 2", 4));
  await check("delete asks first and says the handoffs stay", "document.querySelector('.project-confirm[role=alert] p').textContent === 'Its 1 handoff stays, without a project.' && document.activeElement.textContent === 'Cancel'");
  await click(".project-confirm .btn.danger");
  await wait(`${rowTag("Web app task")} === ''`);
  await check("delete leaves the handoff without a project", `!${manageNames}.includes('Web App 2')`);
  await browser("press", "Escape");
  await check("Escape closes the dialog and returns focus to its button", "!document.querySelector('dialog[open]') && document.activeElement.matches(\"button[aria-label='Manage projects']\")");

  await browser("set", "viewport", "390", "844");
  await wait("innerWidth === 390");
  if (await evaluate("!!document.querySelector('.workspace.show-detail')")) await click(".detail-pane .back");
  await click("button[aria-label='Manage projects']");
  await wait("document.querySelector('dialog.project-manage[open]') !== null");
  await openMenu("AgentRelay"); await click(menuItem("AgentRelay", 2));
  await check("the dialog and its merge panel fit a phone screen", "(() => { const dialog = document.querySelector('dialog.project-manage'); const box = dialog.getBoundingClientRect(); return dialog.scrollWidth <= dialog.clientWidth && box.left >= 0 && box.right <= innerWidth && document.querySelector('.project-confirm').getBoundingClientRect().right <= box.right; })()");
  await capture("mobile-manage");
  await browser("press", "Escape"); await browser("press", "Escape");
  await check("Escape closes the merge panel first, then the dialog", "!document.querySelector('dialog[open]')");
  await browser("set", "viewport", "1440", "1000");
  await wait("innerWidth === 1440");

  // Storage filters by project id through a select of the registry.
  await openStorage();
  await wait("document.querySelector('.storage-table-wrap')?.getAttribute('aria-busy') === 'false'");
  await click(".storage-advanced summary");
  await browser("select", ".storage-advanced label:first-child select", await projectId("AgentRelay"));
  await wait("document.querySelector('.storage-table-wrap')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.storage-table tbody tr').length === 4");
  await check("Storage lists projects (archived marked) and filters by the chosen one", "[...document.querySelectorAll('.storage-advanced label:first-child option')].map(option => option.textContent).join('|') === 'All projects|AgentRelay|docs-site (archived)' && [...document.querySelectorAll('.storage-row-meta')].every(meta => meta.textContent.startsWith('AgentRelay'))");
  await capture("storage-project");

  const errors = await browser("errors");
  assert.equal((Array.isArray(errors) ? errors : errors.errors ?? []).length, 0, `Unexpected browser errors: ${JSON.stringify(errors)}`);
  checks.push("browser console has no runtime errors");
  await writeFile(path.join(output, "results.json"), JSON.stringify({ base, checks, viewports: [[1440, 1000], [390, 844]], browser: "agent-browser", deployment: "not tested" }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  sql(`DELETE FROM handoffs WHERE owner_id = '${owner}'; DELETE FROM projects WHERE owner_id = '${owner}'; DELETE FROM devices WHERE owner_id = '${owner}';`);
  await browser("close").catch(() => {});
}
