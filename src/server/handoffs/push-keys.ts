import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { pushKeys } from "@/server/db/schema";
import type { VapidConfig } from "./notification-delivery";

/** The VAPID contact when the Site's own address is not https (a local preview): push services only need a valid https or mailto URL. */
const FALLBACK_SUBJECT = "https://localhost";

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** The Site's address names its operator to the push services; nothing personal is ever used. */
export function pushSubjectFor(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname ? url.origin : FALLBACK_SUBJECT;
  } catch { return FALLBACK_SUBJECT; }
}

/** A new pair in the same form as the runtime values: the raw uncompressed public point and the private scalar, both base64url. */
export async function generatePushKeys(subject: string): Promise<VapidConfig> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = base64url(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  if (!d) throw new Error("The push key could not be exported.");
  return { publicKey, privateKey: d, subject };
}

/** True when the Site's operator switched notifications off; read without the database, so callers can stop before scheduling anything. */
export function pushSwitchedOff() {
  return env.AGENTRELAY_WEB_PUSH_ENABLED === "0";
}

async function storedPushKeys(owner: string): Promise<VapidConfig | null> {
  const [row] = await getDb().select({ publicKey: pushKeys.publicKey, privateKey: pushKeys.privateKey, subject: pushKeys.subject })
    .from(pushKeys).where(eq(pushKeys.ownerId, owner));
  return row ?? null;
}

/**
 * The key pair notifications are signed with, or null when they are switched off. Runtime values win when all three are
 * set, which keeps Sites that were configured by hand on their existing pair. Otherwise the workspace's stored pair is
 * used; with `origin` (a browser reading its settings) a missing pair is made first, so notifications work from the first
 * deployment without any setup. Delivery never passes `origin`: a workspace without a pair has no subscriptions to reach.
 */
export async function pushConfig(owner: string, origin?: string): Promise<VapidConfig | null> {
  if (pushSwitchedOff()) return null;
  if (env.AGENTRELAY_VAPID_PUBLIC_KEY && env.AGENTRELAY_VAPID_PRIVATE_KEY && env.AGENTRELAY_VAPID_SUBJECT)
    return { publicKey: env.AGENTRELAY_VAPID_PUBLIC_KEY, privateKey: env.AGENTRELAY_VAPID_PRIVATE_KEY, subject: env.AGENTRELAY_VAPID_SUBJECT };
  const stored = await storedPushKeys(owner);
  if (stored || origin === undefined) return stored;
  // Two first readings can race; the row that lands first is the workspace's pair and the other one is discarded.
  const fresh = await generatePushKeys(pushSubjectFor(origin));
  await getDb().insert(pushKeys).values({ ownerId: owner, ...fresh, createdAt: Date.now() }).onConflictDoNothing();
  return storedPushKeys(owner);
}
