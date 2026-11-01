/* Push-only worker: it never intercepts fetches or caches private application responses. */
const DATABASE = "agentrelay-notifications-v1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Notification storage unavailable"));
  });
}

async function state(key, value, write = false) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", write ? "readwrite" : "readonly"), store = transaction.objectStore("state");
      const request = write ? store.put(value, key) : store.get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(new Error("Notification storage unavailable"));
    });
  } finally { db.close(); }
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const message = event.data;
  if (message?.type === "agentrelay.configure-notifications" && (message.browserId === null || UUID.test(message.browserId))) {
    // Say so when the settings cannot be stored (some profiles refuse IndexedDB): without them no push could be shown properly.
    event.waitUntil(state("configuration", { browserId: message.browserId, locale: message.locale === "zh" ? "zh" : "en" }, true)
      .then(() => event.ports[0]?.postMessage({ ok: true }), () => event.ports[0]?.postMessage({ ok: false })));
  } else if (message?.type === "agentrelay.notification-diagnostics") {
    event.waitUntil(state("lastReceipt").then(value => event.ports[0]?.postMessage(value ?? null)));
  } else if (message?.type === "agentrelay.read-configuration") {
    // The page compares this with what the Site holds and repairs a worker that lost its settings.
    event.waitUntil(state("configuration").catch(() => null).then(value => event.ports[0]?.postMessage(value ? { browserId: value.browserId ?? null, locale: value.locale === "zh" ? "zh" : "en" } : null)));
  } else if (message?.type === "agentrelay.sync-waiting" && Array.isArray(message.ids) && message.ids.length <= 500 && message.ids.every(id => UUID.test(id))) {
    event.waitUntil(closeStale(new Set(message.ids)));
  }
});

/** A handoff notification stays on screen until someone acts; once its handoff is no longer waiting it is only noise. */
async function closeStale(waiting) {
  const prefix = "agentrelay:handoff:";
  for (const notification of await self.registration.getNotifications()) {
    if (notification.tag?.startsWith(prefix) && !waiting.has(notification.tag.slice(prefix.length))) notification.close();
  }
}

const text = zh => ({
  testTitle: zh ? "AgentRelay 测试通知" : "AgentRelay test notification",
  testBody: zh ? "推送已到达此浏览器。项目：通知验证" : "Push reached this browser. Project: Notification verification",
  waiting: zh ? "有新的交接等待查看" : "A new handoff is waiting",
  signIn: zh ? "有新的交接，打开 AgentRelay 登录后查看。" : "A handoff is waiting. Open AgentRelay and sign in to view it.",
  gone: zh ? "有一个交接已不在等待中。" : "A handoff was sent here but is no longer waiting.",
  expiringTitle: zh ? "Agent 连接即将过期" : "Agent connection expiring",
  expiring: (name, left) => name ? (zh ? `“${name}”将在 ${left}后过期，请在 AgentRelay 中续期。` : `“${name}” expires in ${left}. Renew it in AgentRelay.`)
    : (zh ? `有一个 Agent 连接将在 ${left}后过期，请在 AgentRelay 中续期。` : `An agent connection expires in ${left}. Renew it in AgentRelay.`),
  expiringSignIn: zh ? "有一个 Agent 连接即将过期，打开 AgentRelay 登录后续期。" : "An agent connection expires soon. Open AgentRelay and sign in to renew it.",
  expiringGone: zh ? "这条连接过期提醒已不再需要。" : "A connection expiry reminder is no longer needed.",
  progress: (step, device) => step === "done"
    ? (device ? (zh ? `已在 ${device} 完成` : `Done on ${device}`) : (zh ? "你发出的交接已完成" : "A handoff you sent is done"))
    : (device ? (zh ? `已被 ${device} 领取` : `Claimed on ${device}`) : (zh ? "你发出的交接已被领取" : "A handoff you sent was claimed")),
  progressSignIn: zh ? "你发出的交接有了进展，打开 AgentRelay 登录后查看。" : "A handoff you sent has moved on. Open AgentRelay and sign in to view it.",
  progressGone: zh ? "你发出的交接之后又有了变化。" : "A handoff you sent has changed again since.",
});

/** Time left before a connection expires, rounded to the unit a person would say: minutes, then hours, then days. */
function timeLeft(ms, zh) {
  const minutes = Math.max(1, Math.round(ms / 60_000)), hours = Math.round(minutes / 60), days = Math.round(hours / 24);
  const [count, unit] = minutes < 60 ? [minutes, zh ? "分钟" : "minute"] : hours < 24 ? [hours, zh ? "小时" : "hour"] : [days, zh ? "天" : "day"];
  return zh ? `${count} ${unit}` : `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * What the Site says about an event, read with the person's own session:
 * `test`, `handoff` and `connection` carry display data, `gone` means signed in but nothing is waiting any more (or the event is stale),
 * and `unavailable` means the session could not be used (signed out, redirected to sign-in, offline or an error).
 * Only `gone` is a definite answer; anything unreadable must never claim a handoff has disappeared.
 */
async function metadata(event, configuration) {
  const query = `?browserId=${encodeURIComponent(configuration.browserId)}`;
  const path = event.type === "agentrelay.test" ? `/api/notifications${query}`
    : event.type === "agentrelay.connection-expiring" ? `/api/notifications/connections/${encodeURIComponent(event.connectionId)}${query}`
    : `/api/notifications/handoffs/${encodeURIComponent(event.handoffId)}${query}${event.type === "agentrelay.handoff-progress" ? "&kind=progress" : ""}`;
  let response;
  try { response = await fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) }); }
  catch { return { kind: "unavailable" }; }
  if (response.status === 404) return { kind: "gone" };
  if (!response.ok) return { kind: "unavailable" };
  let result;
  try { result = await response.json(); } catch { return { kind: "unavailable" }; }
  if (event.type === "agentrelay.test") return result.subscription && !result.subscription.disabledAt ? { kind: "test" } : { kind: "gone" };
  // A renewed connection has a new expiry, so a reminder for the old one is stale.
  if (event.type === "agentrelay.connection-expiring") return result.id === event.connectionId && result.expiresAt === event.expiresAt
    ? { kind: "connection", name: typeof result.name === "string" ? result.name : "", expiresAt: result.expiresAt } : { kind: "gone" };
  // A progress event is current only while the handoff still sits at the version and step it announced.
  if (event.type === "agentrelay.handoff-progress") return result.id === event.handoffId && result.version === event.version && result.status === event.progress
    ? { kind: "progress", title: result.title, device: typeof result.device === "string" ? result.device : "" } : { kind: "gone" };
  return result.id === event.handoffId && result.version === event.version ? { kind: "handoff", title: result.title, project: result.project } : { kind: "gone" };
}

/** Ask a page to do something and wait briefly for its answer on a private channel; a page that never answers counts as "no". */
function askClient(client, data, answerKey) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
    const timer = setTimeout(() => finish(false), 800);
    channel.port1.onmessage = event => finish(event.data?.[answerKey] === true);
    try { client.postMessage(data, [channel.port2]); } catch { finish(false); }
  });
}

async function receivePush(event) {
  let message;
  try { message = event.data?.json(); } catch { return; }
  if (!message || !["agentrelay.test", "agentrelay.handoff-ready", "agentrelay.handoff-progress", "agentrelay.connection-expiring"].includes(message.type)
    || typeof message.eventId !== "string" || message.eventId.length > 180
    || (message.system !== undefined && typeof message.system !== "boolean")
    || ((message.type === "agentrelay.handoff-ready" || message.type === "agentrelay.handoff-progress") && (!UUID.test(message.handoffId) || !Number.isInteger(message.version)))
    || (message.type === "agentrelay.handoff-progress" && !["claimed", "done"].includes(message.progress))
    || (message.type === "agentrelay.connection-expiring" && (!UUID.test(message.connectionId) || !Number.isSafeInteger(message.expiresAt)))) return;
  const configuration = await state("configuration").catch(() => null);
  if (!configuration?.browserId) return;
  const seen = await state("seenEvents").catch(() => []) || [];
  if (seen.includes(message.eventId)) return;
  const display = await metadata(message, configuration), copy = text(configuration.locale === "zh");
  const handoff = message.type === "agentrelay.handoff-ready", connection = message.type === "agentrelay.connection-expiring";
  const progress = message.type === "agentrelay.handoff-progress";
  let title = connection ? copy.expiringTitle : "AgentRelay", body = connection ? copy.expiringSignIn : progress ? copy.progressSignIn : copy.signIn, silent = false;
  if (display.kind === "test") { title = copy.testTitle; body = copy.testBody; }
  else if (display.kind === "handoff") { title = display.title || "AgentRelay"; body = display.project || copy.waiting; }
  else if (display.kind === "progress") { title = display.title || "AgentRelay"; body = copy.progress(message.progress, display.device); }
  else if (display.kind === "connection") body = copy.expiring(display.name, timeLeft(display.expiresAt - Date.now(), configuration.locale === "zh"));
  // Chrome still wants a visible notification for every push, so a handoff or reminder that has gone gets a quiet one.
  else if (display.kind === "gone") { body = connection ? copy.expiringGone : progress ? copy.progressGone : copy.gone; silent = true; }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // A test insists on a system notification: a page that merely shows a notice would prove nothing about delivery.
  const client = message.system === true ? null : windows.find(item => item.visibilityState === "visible" && item.focused)
    || windows.find(item => item.visibilityState === "visible");
  const foreground = client && await askClient(client, { type: "agentrelay.notification", eventId: message.eventId, title, body,
    handoffId: message.handoffId, connectionId: connection ? message.connectionId : undefined, gone: display.kind === "gone",
    progress: progress ? message.progress : undefined,
    detail: display.kind === "handoff" && display.title ? display.title : display.kind === "connection" ? body
      : display.kind === "progress" ? (display.title ? `${body}: ${display.title}` : body).slice(0, 200) : null }, "displayed");
  if (!foreground) {
    // One notification per handoff or connection: a newer version or a later reminder replaces the earlier one and alerts
    // again. Transport retries of the same event never get this far, because the durable check above has already seen
    // their event id. Chrome refuses `renotify` together with `silent`.
    // A handoff's progress has its own tag, so "done" replaces "claimed" without touching an arrival shown for the same handoff.
    const tag = handoff ? `agentrelay:handoff:${message.handoffId}` : progress ? `agentrelay:progress:${message.handoffId}`
      : connection ? `agentrelay:connection:${message.connectionId}` : `agentrelay:${message.eventId}`;
    await self.registration.showNotification(title, { body, tag, renotify: (handoff || progress || connection) && !silent, ...(silent ? { silent: true } : {}), icon: "/favicon.svg",
      data: { handoffId: message.handoffId ?? null, connectionId: connection ? message.connectionId : null } });
  }
  await state("lastReceipt", { at: Date.now(), foreground: !!foreground, authenticated: display.kind !== "unavailable", outcome: display.kind, eventId: message.eventId }, true).catch(() => {});
  await state("seenEvents", [...seen, message.eventId].slice(-128), true).catch(() => {});
}
// Serialize deliveries so simultaneous retries cannot both pass the durable duplicate check.
let pushFlight = Promise.resolve();
self.addEventListener("push", event => {
  const task = pushFlight.then(() => receivePush(event));
  pushFlight = task.catch(() => {});
  event.waitUntil(task);
});

/** Reuse an open tab without reloading it: the page shows what was asked itself, and a page too old to know how is navigated. */
async function openApp(path, request) {
  const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(item => new URL(item.url).origin === self.location.origin);
  const client = windows.find(item => item.focused) || windows.find(item => item.visibilityState === "visible") || windows[0];
  if (!client) { await self.clients.openWindow(path); return; }
  await client.focus().catch(() => {});
  if (!request || await askClient(client, request, "handled")) return;
  const navigated = await client.navigate(path).catch(() => null);
  await navigated?.focus?.();
}
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.handoffId, valid = UUID.test(id);
  // An expiry reminder opens the connection list, where the connection can be renewed.
  if (!valid && UUID.test(event.notification.data?.connectionId)) { event.waitUntil(openApp("/?view=agent", { type: "agentrelay.open-connections" })); return; }
  event.waitUntil(openApp(valid ? `/?handoff=${encodeURIComponent(id)}` : "/", valid ? { type: "agentrelay.open-handoff", id } : null));
});
