import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { NotificationEvent } from "@/shared/contracts/notifications";
import { pushEndpointOf } from "./notification-validation";

type Destination = { endpoint: string; p256dh: string; auth: string };
export type VapidConfig = { publicKey: string; privateKey: string; subject: string };
type DeliveryDependencies = { fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };
export type DeliveryResult = { accepted: boolean; disabled: boolean; error: string | null };

/** Never let push-service bodies or network exception messages escape into logs or browser-visible status. */
export async function deliverNotification(destination: Destination, event: NotificationEvent, vapid: VapidConfig, dependencies: DeliveryDependencies = {}): Promise<DeliveryResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch, now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + 20_000;
  let endpoint: string, payload: RequestInit;
  try {
    endpoint = pushEndpointOf(destination.endpoint);
    payload = await buildPushPayload({ data: JSON.stringify(event), options: { ttl: 86400 } }, {
      endpoint, keys: { p256dh: destination.p256dh, auth: destination.auth }, expirationTime: null,
    }, vapid);
  } catch { return { accepted: false, disabled: false, error: "configuration" }; }
  let error = "network";
  for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
    let delay = 500 * (attempt + 1);
    try {
      // Workers rejects redirect:"error" before sending. Manual mode exposes 3xx below without following it.
      const response = await fetchImpl(endpoint, { ...payload, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - now()))) });
      const status = response.status, retryAfter = response.headers.get("retry-after");
      await response.body?.cancel();
      if (status >= 200 && status < 300) return { accepted: true, disabled: false, error: null };
      if (status === 404 || status === 410) return { accepted: false, disabled: true, error: "subscription-expired" };
      error = `http-${status}`;
      if (status !== 429 && status < 500) break;
      if (retryAfter) {
        const seconds = Number(retryAfter), timestamp = Date.parse(retryAfter);
        const requested = Number.isFinite(seconds) ? seconds * 1000 : timestamp - now();
        if (Number.isFinite(requested)) delay = Math.max(delay, requested);
      }
    } catch { error = "network"; }
    if (attempt === 2 || now() + delay >= deadline) break;
    await sleep(delay);
  }
  return { accepted: false, disabled: false, error };
}
