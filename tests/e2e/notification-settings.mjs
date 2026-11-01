// Browser acceptance for Settings › Notifications and the footer reminder, on a built Worker that has push configured.
// A real push subscription needs Google's push service, so the page's browser APIs are replaced by small fakes (user agent
// data, permission, the push manager); everything else, including the Site's API and the real service worker, is genuine.
// Start the Worker with `node tests/integration/run-notification-events.mjs tests/e2e/notification-settings.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Notification browser checks require a local Worker.");
const run = crypto.randomUUID(), owner = `notify-settings-${run}`, session = `notify-s-${run.slice(0, 8)}`;
const output = path.resolve(`outputs/notification-settings-e2e/${run}`), headers = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": "notify@sites.test" };
const binary = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
await mkdir(output, { recursive: true });

// A persistent profile directory, because the browser's default temporary profile refuses IndexedDB, which the worker needs.
const profile = process.env.AGENT_BROWSER_PROFILE ?? path.join(output, "profile");
async function browser(...args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--json", "--profile", profile, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => { child.stdout.destroy(); child.stderr.destroy(); if (code === 0) resolve(text); else reject(new Error(error || text)); });
  });
  const result = JSON.parse(stdout.trim()); if (!result.success) throw new Error(result.error); return result.data;
}
const evaluate = async script => (await browser("eval", "-b", Buffer.from(script).toString("base64"))).result;
const click = selector => browser("click", selector);
// A wait that gives up says what the page looked like, because the cause is usually visible there.
const wait = expression => browser("wait", "--fn", expression).catch(async error => {
  const page = await evaluate("JSON.stringify({ settings: document.querySelector('.settings')?.innerText ?? null, calls: window.__calls ?? null, toast: document.querySelector('.toast')?.innerText ?? null })").catch(() => "{}");
  throw new Error(`${error.message}\nWaiting for: ${expression}\nPage: ${page}`);
});
const capture = name => browser("screenshot", path.join(output, `${name}.png`));
const checks = [];
async function check(name, expression) { assert.equal(await evaluate(expression), true, name); checks.push(name); console.log(`PASS ${name}`); }
async function api(route, method = "GET", data) {
  const response = await fetch(base + route, { method, headers: { ...headers, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
}
const encode = bytes => Buffer.from(bytes).toString("base64url");
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const keys = { p256dh: encode(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth: encode(crypto.getRandomValues(new Uint8Array(16))) };
const subscription = name => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys });

const STATE = "document.querySelector('#setting-notifications')?.closest('.setting-group')?.querySelector('p[role=status][data-state]')?.dataset.state";
const FOOTER = "document.querySelector('.foot-status .notification-indicator')";
const hasText = (selector, text) => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').includes(${JSON.stringify(text)})`;
const openNotifications = async () => { await click(".settings-button"); await click("[data-settings-section=notifications]"); };
const openInbox = () => click(".tabs [data-view='inbox']");
/** Replace the browser APIs the page reads. `window.__perm` and `window.__sub` can be changed afterwards and the page told to look again. */
const fakeBrowser = permission => evaluate(`(async () => {
  window.__perm = ${JSON.stringify(permission)}; window.__calls = window.__calls ?? [];
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({ mobile: false, platform: 'Windows', brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }] }) });
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => window.__perm });
  Notification.requestPermission = async () => { window.__calls.push('permission'); window.__perm = 'granted'; return 'granted'; };
  // A page that cannot use notifications has not made its browser id yet; make it the way the app does.
  const id = localStorage.getItem('agentrelay.notifications.browser-id.v1') ?? crypto.randomUUID();
  localStorage.setItem('agentrelay.notifications.browser-id.v1', id);
  const settings = await (await fetch('/api/notifications?browserId=' + id)).json();
  const key = Uint8Array.from(atob(settings.publicKey.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const make = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/fake-browser', options: { applicationServerKey: key.buffer },
    unsubscribe: async () => { window.__calls.push('unsubscribe'); window.__sub = null; return true; },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/fake-browser', keys: ${JSON.stringify(keys)} }) });
  window.__sub = window.__sub ?? null;
  PushManager.prototype.getSubscription = async () => window.__sub;
  PushManager.prototype.subscribe = async () => { window.__calls.push('subscribe'); window.__sub = make(); return window.__sub; };
  window.__make = make;
  const realFetch = window.fetch;
  // The test route would contact Google's service from the Worker; record the call instead.
  window.fetch = (input, init) => String(input).includes('/api/notifications/test') ? (window.__calls.push('test'), Promise.resolve(Response.json({ queued: true }, { status: 202 }))) : realFetch(input, init);
  return true;
})()`);
/** Tell every part of the app that notifications may have changed, as another tab would. */
const lookAgain = () => evaluate("(() => { const channel = new BroadcastChannel('agentrelay-notifications'); channel.postMessage('changed'); channel.close(); return true; })()");
const calls = () => evaluate("JSON.stringify(window.__calls ?? [])").then(JSON.parse);
const browserId = () => evaluate("localStorage.getItem('agentrelay.notifications.browser-id.v1')");
const serverRow = async () => (await api(`/api/notifications?browserId=${await browserId()}`)).subscription;

try {
  for (const name of ["Laptop", "Desktop"]) await api("/api/devices", "POST", { name });
  await browser("--headers", JSON.stringify(headers), "open", base);
  await browser("set", "viewport", "1440", "1000");
  await browser("set", "media", "light");
  await wait("document.querySelector('.settings-button') !== null");

  // 1. A headless browser is not Chrome or Edge on a computer, so the feature is explained rather than offered.
  await wait("document.querySelector('.list-foot') !== null");
  await check("an unsupported browser sees no footer reminder", `${FOOTER} === null`);
  await openNotifications();
  await wait(`${STATE} === 'unsupported'`);
  await check("the settings explain which browsers are supported and offer nothing to turn on", `${hasText(".setting-group .setting-text", "Chrome or Edge on a computer")} && ![...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Turn on')`);
  await check("every control is disabled", "[...document.querySelectorAll('.settings-general input, .settings-general select, .settings-general .setting-row .btn')].every(control => control.disabled)");
  await check("the segmented control reads General, Notifications, Storage", "[...document.querySelectorAll('.settings-tabs button')].map(b => b.textContent).join('|') === 'General|Notifications|Storage' && document.querySelector('[data-settings-section=notifications]').getAttribute('aria-pressed') === 'true'");
  await capture("unsupported");

  // 2. Supported but never turned on: the options are visible and disabled, and the footer shows a quiet icon until the settings have been seen.
  await evaluate("localStorage.removeItem('agentrelay.notifications.hint-seen.v1'); true");
  await openInbox(); await fakeBrowser("default"); await lookAgain();
  await wait(`${FOOTER} !== null`);
  await check("a browser that never had notifications gets an icon in the footer, without words", `${FOOTER}.textContent.trim() === '' && ${FOOTER}.getAttribute('aria-label') === 'Notifications off'`);
  await click(".foot-status .notification-indicator");
  await wait(`${STATE} === 'off'`);
  await check("the reminder opens Settings › Notifications, where Turn on is offered and the options wait", "document.querySelector('[data-settings-section=notifications]').getAttribute('aria-pressed') === 'true' && [...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Turn on' && !b.disabled) && document.querySelector('.setting-checks input').disabled && document.querySelector('#notification-details').disabled");
  await check("the device to notify defaults to the device used in the top bar", "document.querySelector('#notification-device').selectedOptions[0].textContent === 'Laptop' && !document.querySelector('#notification-device').disabled");
  await capture("off");
  await openInbox();
  await check("having looked at the settings retires the reminder", `${FOOTER} === null`);

  // 2b. The browser collapses the request into an address-bar icon: while it is open, and after it closes unanswered, the
  // settings say where to look in this browser.
  await openNotifications();
  await evaluate("window.__grant = Notification.requestPermission; Notification.requestPermission = () => new Promise(answer => { window.__calls.push('permission'); window.__answer = answer; }); true");
  await click(".settings .btn.primary");
  await wait(hasText(".notification-note", "crossed-out bell"));
  await check("an open request in Chrome points at the crossed-out bell", `${hasText(".setting-group .setting-text", "Chrome is asking for permission")} && [...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Turn on').disabled`);
  await capture("prompt-waiting");
  // Chrome's own settings page is the fallback, so it waits behind the information button beside the title.
  await click(".setting-group .setting-text .info-tip-trigger"); await wait("document.querySelector('.info-tip') !== null");
  await check("the information button points at Chrome's own settings page", hasText(".info-tip", "chrome://settings/content/notifications"));
  await browser("press", "Escape"); await wait("document.querySelector('.info-tip') === null");
  await evaluate("window.__answer('default'); true");
  await wait(hasText(".notification-note", "did not get an answer"));
  await check("an unanswered request leaves notifications off and offers Turn on again", `${STATE} === 'off' && [...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Turn on' && !b.disabled)`);
  await evaluate("Notification.requestPermission = window.__grant; true");
  await openInbox();


  // 3. Permission blocked.
  await evaluate("window.__perm = 'denied'; true"); await lookAgain();
  await wait(`${FOOTER}?.textContent === 'Notifications blocked'`);
  await check("a blocked browser gets a worded reminder in the warning colour", `${FOOTER}.dataset.tone === 'warn'`);
  await openNotifications();
  await check("the settings say how to unblock in Chrome and offer no button", `${hasText(".setting-group .setting-text", "Blocked in this browser")} && ${hasText(".setting-group .setting-text", "site information icon")} && !${hasText(".setting-group .setting-text", "Chrome did not get an answer")} && ![...document.querySelectorAll('.settings .btn')].some(b => ['Turn on', 'Reconnect'].includes(b.textContent))`);
  await capture("blocked");
  await evaluate("window.__brand = Object.getOwnPropertyDescriptor(navigator, 'userAgentData').get; Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({ mobile: false, platform: 'Windows', brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand: 'Microsoft Edge' }] }) }); true");
  await lookAgain();
  await wait(hasText(".notification-note", "lock icon"));
  await check("Edge is told to use the lock icon instead", `${hasText(".setting-group .setting-text", "Edge blocked notifications for this site")}`);
  await capture("blocked-edge");
  await evaluate("Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: window.__brand }); true");

  // 4. The Site has a subscription but the browser lost its permission: only a click can fix that.
  await api("/api/notifications", "PUT", { browserId: await browserId(), deviceId: "laptop", locale: "en", subscription: subscription("fake-browser"), label: "Chrome on Windows" });
  await evaluate("window.__perm = 'default'; true"); await lookAgain();
  await wait(`${STATE} === 'reconnect'`);
  await check("a lost permission reads Needs reconnecting with a Reconnect button", `${hasText(".setting-group .setting-text", "Needs reconnecting")} && [...document.querySelectorAll('.settings .btn')].some(b => b.textContent === 'Reconnect')`);
  await openInbox();
  await check("the footer asks to reconnect", `${FOOTER}?.textContent === 'Reconnect notifications'`);

  // 5. Reconnect from a click: permission is asked for first, then the push subscription is made and registered.
  await openNotifications();
  await click(".settings .btn.primary");
  await wait(`${STATE} === 'on'`);
  const afterReconnect = await calls();
  assert.equal(afterReconnect[0], "permission"); assert.ok(afterReconnect.includes("subscribe"));
  checks.push("reconnecting asks for permission before anything else, then subscribes"); console.log("PASS reconnecting asks for permission before anything else, then subscribes");
  await check("the status is On for the bound device", `${hasText(".setting-group .setting-text", "On · for Laptop")}`);
  await openInbox();
  await check("no reminder is shown while notifications are on", `${FOOTER} === null`);
  await openNotifications();
  assert.equal((await serverRow()).label, "Chrome on Windows"); checks.push("the Site keeps the browser's label"); console.log("PASS the Site keeps the browser's label");

  // 6. Options are saved as they change, on the Site.
  await check("the defaults are requeues on, Any device off and details shown", "(() => { const [requeue, any] = document.querySelectorAll('.setting-checks input'); return requeue.checked && !any.checked && document.querySelector('#notification-details').checked && !requeue.disabled; })()");
  await click(".setting-checks label:nth-child(2) input");
  await wait("document.querySelectorAll('.setting-checks input')[1].checked");
  assert.equal((await serverRow()).notifyAny, true); checks.push("turning on Any device is saved"); console.log("PASS turning on Any device is saved");
  await click(".setting-checks label:nth-child(1) input");
  await wait("!document.querySelectorAll('.setting-checks input')[0].checked");
  assert.equal((await serverRow()).notifyRequeue, false); checks.push("turning off requeues is saved"); console.log("PASS turning off requeues is saved");
  await click("#notification-details");
  await wait("!document.querySelector('#notification-details').checked");
  assert.equal((await serverRow()).showDetails, false); checks.push("hiding the title and project is saved"); console.log("PASS hiding the title and project is saved");
  await check("connection expiry reminders default to this device's connections", "document.querySelector('#notification-expiry').value === 'device' && !document.querySelector('#notification-expiry').disabled");
  await evaluate("(() => { const select = document.querySelector('#notification-expiry'); select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await wait("document.querySelector('#notification-expiry').value === 'all'");
  for (let turn = 0; turn < 40 && (await serverRow()).notifyExpiry !== "all"; turn++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await serverRow()).notifyExpiry, "all"); checks.push("reminding about all connections is saved"); console.log("PASS reminding about all connections is saved");
  await evaluate("(() => { const select = document.querySelector('#notification-device'); select.value = 'desktop'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await wait("document.querySelector('.setting-group .setting-text p[role=status]').textContent.includes('for Desktop')");
  assert.equal((await serverRow()).deviceId, "desktop"); checks.push("changing the device moves the subscription and the status follows"); console.log("PASS changing the device moves the subscription and the status follows");
  await capture("on-en");

  // 7. Test and delivery details.
  await evaluate("(() => { [...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Send test notification').click(); return true; })()");
  await wait("(document.body.textContent ?? '').includes('Test sent')");
  assert.ok((await calls()).includes("test")); checks.push("a test is requested and acknowledged on the page"); console.log("PASS a test is requested and acknowledged on the page");
  await evaluate("document.querySelector('.notification-details').open = true; true");
  await check("the delivery details list the three records", "[...document.querySelectorAll('.notification-details dt')].map(node => node.textContent).join('|') === 'Last accepted by the push service|Last error|Last received by this browser'");

  // 8. Other browsers of the workspace.
  const other = crypto.randomUUID();
  await api("/api/notifications", "PUT", { browserId: other, deviceId: "desktop", locale: "en", subscription: subscription("other-browser"), label: "Edge on Windows" });
  await lookAgain();
  await wait("document.querySelector('.other-browsers') !== null");
  await check("another browser is listed by label, device and delivery history", "(() => { const text = document.querySelector('.other-browsers li').textContent; return text.includes('Edge on Windows') && text.includes('Desktop') && text.includes('never delivered'); })()");
  await check("its address, keys and ids are not in the page", "!/fake-browser|other-browser(?!s)|p256dh|fcm\\.googleapis/.test(document.querySelector('.settings').innerHTML)");
  await capture("others");
  await click(".other-browsers .btn");
  await wait("document.querySelector('.other-browsers') === null");
  assert.equal((await api(`/api/notifications?browserId=${await browserId()}`)).others.length, 0); checks.push("removing another browser deletes it on the Site"); console.log("PASS removing another browser deletes it on the Site");
  await check("a confirmation appears", "(document.querySelector('.toast')?.textContent ?? '').includes('Browser removed')");

  // 9. Language, then turning off and on again.
  await click("[data-settings-section=general]"); await click(".lang-switch button[lang='zh-CN']"); await click("[data-settings-section=notifications]");
  await wait(`${hasText(".setting-group .setting-text", "已开启")}`);
  await check("the settings follow the interface language", `${hasText(".setting-group h2", "此浏览器")} && ${hasText(".setting-group .setting-text", "接收发给 Desktop 的交接")}`);
  await capture("on-zh");
  await click("[data-settings-section=general]"); await click(".lang-switch button[lang='en']"); await click("[data-settings-section=notifications]");
  await evaluate("(() => { [...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Turn off').click(); return true; })()");
  await wait(`${STATE} === 'off'`);
  assert.equal(await serverRow(), null); checks.push("turning off removes the subscription from the Site"); console.log("PASS turning off removes the subscription from the Site");
  assert.ok((await calls()).includes("unsubscribe")); checks.push("turning off also unsubscribes the browser"); console.log("PASS turning off also unsubscribes the browser");
  await evaluate("(() => { [...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Turn on').click(); return true; })()");
  await wait(`${STATE} === 'on'`);
  assert.ok((await serverRow()).deviceId); checks.push("turning on again registers a new subscription"); console.log("PASS turning on again registers a new subscription");

  // 10. Phone width and dark scheme.
  await browser("set", "viewport", "390", "800");
  await check("the settings fit a phone screen", "document.documentElement.scrollWidth <= innerWidth");
  await capture("on-phone");
  await browser("set", "media", "dark"); await browser("set", "viewport", "1440", "1000");
  await capture("on-dark");
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser("close").catch(() => {});
}
