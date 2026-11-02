# Browser notifications

AgentRelay can show a system notification when a handoff arrives for a device, even when no AgentRelay tab is open. It uses the browser's standard Web Push: no extension, no installed app and no program running on your computer. The browser itself has to stay running.

## Who can use it

Notifications are available on **desktop Chrome and desktop Edge** and are limited to them. Other browsers, and phones and tablets, see Settings › Notifications with every control disabled and a line saying so. Live acceptance on 2026-11-02 covered the upgraded build on a freshly deployed Site with no push runtime values, so the Worker generated its own keys: on Windows, Chrome and Edge each showed the test notification after **Turn on**, and a handoff created in Edge for the Chrome device reached Chrome with every AgentRelay tab closed. These results were observed by the owner. macOS and Linux are untested.

A Site makes its own push keys, so notifications can be turned on from its first deployment without any setup. See [Push keys](#push-keys).

## Turn them on

1. Open **Settings › Notifications** and choose the device this browser should hear about. It starts as the device picked in the top bar, and afterwards only this page changes it. While a new workspace still shows the setup checklist, its optional *Get notified in this browser* step does the same for the device this browser is, without opening Settings.
2. Choose **Turn on** and allow notifications when the browser asks. The prompt only ever appears after this click. Chrome and Edge sometimes show the request only as a bell icon in the address bar (crossed out in Chrome, at the right end in Edge); while the request is open, or after it closes unanswered, the page says where to click in the browser you are using.
3. A test notification is sent as soon as notifications are on (and again after **Reconnect**), so you see at once that they work. If it does not appear, *Didn't see it?* under the status lists what to check. **Send test notification** sends another one at any time.

If the browser blocks notifications, the page says so and how to allow them with that browser's own address-bar controls; AgentRelay does not ask again. After you allow them there, the page notices the change by itself (when the permission changes or the window regains focus) and offers **Turn on**; no reload is needed. If the browser loses its permission or subscription, the footer shows *Reconnect notifications* and Settings offers **Reconnect**.

## What you are notified about

| Option | Default | Meaning |
| --- | --- | --- |
| New handoffs for the device | Always on | A handoff created for the device this browser is bound to |
| Handoffs put back to Ready | On | A claimed or finished handoff returned to Ready for that device |
| Handoffs sent to Any device | Off | A handoff addressed to Any device, whichever device the browser is bound to |
| Handoffs sent from here | When done | A handoff sent from the device this browser is bound to, when another device completes it (*When done*), also when it claims it (*When claimed and done*), or never (*Off*) |
| Connection expiry | This device's connections | Reminders before an Agent connection expires; see below. *All connections* covers every connection in the workspace, *Off* none |
| Show title and project | On | When off, a notification only says that a handoff is waiting, which is safer on a lock screen or a shared screen |

Handoffs that were already waiting before notifications were turned on are never announced, and a retried request that was already saved is not announced twice. Changes are saved as you make them.

Clicking a notification opens that handoff and leaves it Ready. Nothing is claimed or run for you. When a page is already open and visible, you see a small notice with an **Open** action instead of a system notification.

### Progress of handoffs you sent

A handoff's source device is the sender. Its browsers hear when the handoff moves forward on another device:

- *Claimed on Desktop* and *Done on Desktop* name the step and the device that claimed it; with *Show title and project* off they say only that a handoff you sent was claimed or is done.
- A handoff that the sending device claims itself, an undo, and a change that lost a version race are never announced. A handoff whose source is not a registered device has no browsers to tell.
- The completion notice replaces the claim notice for the same handoff. Clicking either opens the handoff, where its result (if the receiver wrote one) is shown under the prompt. The result itself never appears in a notification.
- A notice whose handoff has moved on again before it arrived (requeued, or completed after the claim) becomes a quiet one.

Answering the receiver is a reply handoff, which reaches the receiver's browsers as an ordinary new handoff.

### Connection expiry reminders

A finite Agent connection is reminded about **7 days, 3 days, 1 day and 1 hour** before it expires: at most four reminders per lifetime, each sent once. The rules that keep this quiet:

- A browser hears about connections bound to its own device and connections bound to no device (*This device's connections*), every connection (*All connections*), or none (*Off*).
- A reminder replaces the previous one for the same connection, so the notification centre holds one entry per connection. Clicking it opens the Agents page; nothing is renewed for you.
- A lifetime that starts inside a reminder's window skips that reminder: a 1-day connection is reminded only at 1 hour, a 7-day one at 3 days, 1 day and 1 hour.
- Renewing a connection (a new lifetime) starts the reminders again. Revoked, expired and permanent connections are never reminded.
- AgentRelay does not schedule a reminder job, so it looks for due reminders while the workspace is in use: whenever the open inbox refreshes and whenever an agent makes an MCP request, at most once a minute. A reminder therefore arrives late after a quiet spell. When several reminders' moments passed unseen, only the most urgent one is sent, and none is sent once the connection has expired.
- No browser that wants reminders means nothing is used up: the first browser to turn them on still gets the next one that falls due.

The push carries only the connection id and its expiry. The service worker reads the connection's name with your own session (no name when *Show title and project* is off), and a reminder for a connection that was renewed, revoked or removed in the meantime turns into a quiet notice.

**Other browsers** lists the workspace's other browsers by label, device and the member who turned them on. Remove one to stop its notifications; it can turn them on again. Sound, banners and Do Not Disturb belong to your operating system and browser, not to AgentRelay.

## What a notification contains

The push itself carries only an event id, a handoff id and a version (and, for a progress notice, whether it was claimed or completed). The browser's service worker then reads the title and project with your own signed-in session, so a signed-out or expired session shows only a generic reminder and the click goes to sign-in. Prompt text and images are never part of a push or of that request. If the handoff was picked up before the notification arrived, a quiet notice says it is no longer waiting.

## Push keys

Nothing needs to be configured. Notifications are signed with a VAPID key pair, and a Site makes its own: the first time a browser opens the notification settings, the Worker generates a P-256 pair and stores it in the Site's database (`push_keys`, one row per workspace), with the Site's own address as the contact for the push services. From the first deployment every browser can turn notifications on at any time, and no second deployment is needed. Only the public key ever reaches a browser.

The trade-off: the private key then sits in the same database as the browsers' subscriptions. Someone who can read that database (the Site owner's tooling, a backup or an export) could send pushes to the workspace's subscribed browsers. A push carries no handoff text and grants nothing, so the harm is unwanted notifications, but the private key is still a secret. Treat database exports accordingly.

To keep the private key out of the database, set your own pair as runtime values instead. When all three keys are set they take precedence over the stored pair:

```bash
node scripts/notifications/generate-vapid.mjs --subject https://<your-site>.chatgpt.site --out <a new file outside this repository>
```

`--subject` is a contact address for the push services: your Site's own address or a `mailto:` address. With `--out`, the values go to a new file that only you can read and only the public key is printed; without it all four values are printed once. The command refuses a file inside this checkout so the private key cannot be committed.

| Runtime value | Meaning |
| --- | --- |
| `AGENTRELAY_WEB_PUSH_ENABLED` | `0` switches notifications off for the whole Site; unset or anything else leaves them available |
| `AGENTRELAY_VAPID_PUBLIC_KEY` | The public key, shared with browsers |
| `AGENTRELAY_VAPID_PRIVATE_KEY` | **Secret.** Signs the pushes the Site sends |
| `AGENTRELAY_VAPID_SUBJECT` | The contact address |

Set them through the Sites runtime configuration, for example by asking the agent that deploys the Site to read the file and set the values without printing them, then delete the file or keep it in a password manager. Sites applies new runtime values only on the next deployment. Keep the private key out of source, logs and screenshots. An incomplete set (any of the three keys missing) is ignored and the stored pair stays in use.

Keep the same pair for the life of the Site where you can. Changing pairs (setting runtime values on a Site that used its stored pair, or removing them again) does not break anything permanently: each browser notices the change on its next visit and subscribes again by itself. Pushes sent in between are lost.

## How delivery works

- Every entry point that creates a handoff, returns one to Ready, or claims or completes one (the web page, the native MCP endpoint and the Agent MCP endpoint) announces it after the response has been sent. A failing push never fails or delays the handoff, and the inbox stays the record of what is waiting.
- Each event goes to at most twenty browsers. Temporary failures are retried up to three times within twenty seconds, `Retry-After` is respected within that budget, and a subscription the push service reports as gone is switched off. A push that is not delivered within a day expires. There is no queue that replays missed notifications.
- Only the push services of Chrome (Google FCM) and Edge (the Windows Push Notification Service, `*.notify.windows.com`) are contacted, over HTTPS, and a redirect is never followed.
- The service worker has no fetch handler and caches nothing. It keeps a short list of processed event ids so a retried push is shown once, shows one notification per handoff (a newer version replaces the older one), and closes notifications whose handoff is no longer waiting when you next open the inbox.
- Several tabs share one subscription. Each visit to the app reads the permission, the push subscription and the worker's stored settings and silently repairs what it can, taking turns across tabs.

## When nothing appears

| Symptom | Check |
| --- | --- |
| The test works but handoffs do not notify | The browser is bound to another device, or the handoff was created before notifications were turned on |
| Nothing at all on Windows | Do Not Disturb or Focus is on, or notifications for the browser are off in Windows settings |
| No prompt after Turn on | The browser collapsed the request into a bell icon in the address bar: click it and choose Allow. To get prompts instead, change how sites ask in `chrome://settings/content/notifications` or turn off quiet notification requests in `edge://settings/content/notifications` |
| The page says *Blocked* | Chrome: the site information icon at the left of the address bar, switch Notifications on. Edge: the lock icon, set Notifications to Allow. The page picks up the change by itself |
| *Needs reconnecting* | Choose Reconnect; permission or the subscription was lost |
| *Switched off on this Site* | The Site has `AGENTRELAY_WEB_PUSH_ENABLED=0`; remove it and deploy again |
| The browser was fully closed | Delivery needs the browser running; it is not required to have an AgentRelay tab open |

The delivery details in Settings separate three facts: whether the push service accepted the message, the last error, and whether this browser's worker handled a push. None of them proves that the system displayed a notification.

## For contributors

```bash
npm run test:unit
node tests/integration/verify-notification-delivery-worker.mjs     # the real sender in workerd, with a synthetic push service
npm run test:integration:notifications                             # lifecycle announcements through all three entry points
npm run test:e2e:notifications                                     # the page's reaction to a push, in a real browser
npm run test:e2e:notification-settings                             # Settings › Notifications and the footer chip
```

The last three start or need a built local Worker; the browser checks fake the push APIs because a real subscription needs Google's service. None of this proves a real notification appeared: that needs a short acceptance run in Chrome and Edge on the target operating system, with every AgentRelay tab closed. `POST /api/notifications/test` accepts an optional `handoffId` of a Ready handoff addressed to the bound device, which announces that handoff exactly as an arrival would.
