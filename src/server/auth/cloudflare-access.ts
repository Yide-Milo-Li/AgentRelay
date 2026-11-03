import { env } from "cloudflare:workers";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { PlatformUser } from "./identity";

/**
 * Identity on a standalone deployment: Cloudflare Access signs the person in and forwards a signed application token in
 * `Cf-Access-Jwt-Assertion`. A Worker that serves static assets does not receive `ctx.access`, so the token is verified
 * here against the team's published keys. Only the header is read, never the `CF_Authorization` cookie.
 */
const TOKEN_HEADER = "cf-access-jwt-assertion";
const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_SKEW_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60_000;
/** An unknown key id refetches the key set at most this often per isolate, so forged ids cannot flood the endpoint. */
const KEYS_REFRESH_MS = 60_000;
const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9_-]{8,256}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NOT_CONFIGURED = "This deployment's Cloudflare Access settings are missing or invalid.";
const KEYS_UNAVAILABLE = "Cloudflare Access keys are unavailable. Try again shortly.";

/** A deployment-side failure (settings or keys), as opposed to a person who is not signed in. Answers 503. */
export class AccessUnavailableError extends AgentRelayError {
  constructor(public reason: "unconfigured" | "keys-unavailable") {
    super(reason === "unconfigured" ? NOT_CONFIGURED : KEYS_UNAVAILABLE, 503);
  }
}

export type AccessConfig = { teamDomain: string; audiences: string[]; certsUrl: string };
export type AccessSettings = {
  AGENTRELAY_ACCESS_TEAM_DOMAIN?: string;
  AGENTRELAY_ACCESS_AUD?: string;
  AGENTRELAY_ACCESS_CERTS_URL?: string;
};
export type AccessOptions = { now?: number; fetch?: typeof fetch };

/** Validate the Worker's Access variables. A deployment without them fails closed with 503, never open. */
export function accessConfigFrom(settings: AccessSettings): AccessConfig {
  const teamDomain = (settings.AGENTRELAY_ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/$/, "");
  const audiences = (settings.AGENTRELAY_ACCESS_AUD ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!TEAM_DOMAIN.test(teamDomain) || !audiences.length || !audiences.every(value => AUDIENCE.test(value)))
    throw new AccessUnavailableError("unconfigured");
  const override = (settings.AGENTRELAY_ACCESS_CERTS_URL ?? "").trim();
  return { teamDomain, audiences, certsUrl: override ? certsUrlFrom(override) : `${teamDomain}/cdn-cgi/access/certs` };
}

/** The key set may come from elsewhere (the integration runner serves a test key on loopback), but only over HTTPS. */
function certsUrlFrom(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AccessUnavailableError("unconfigured"); }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.href;
  throw new AccessUnavailableError("unconfigured");
}

type SigningKeys = { keys: Map<string, JsonWebKey>; imported: Map<string, Promise<CryptoKey | null>>; fetchedAt: number };
const keySets = new Map<string, SigningKeys>();

async function fetchKeys(url: string, fetchImpl: typeof fetch, now: number): Promise<SigningKeys> {
  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    body = await response.json();
  } catch {
    throw new AccessUnavailableError("keys-unavailable");
  }
  const listed = (body as { keys?: unknown })?.keys;
  const keys = new Map<string, JsonWebKey>();
  for (const key of Array.isArray(listed) ? listed : []) {
    const kid = (key as { kid?: unknown })?.kid;
    if (typeof kid === "string" && (key as JsonWebKey).kty === "RSA") keys.set(kid, key as JsonWebKey);
  }
  const set = { keys, imported: new Map(), fetchedAt: now };
  keySets.set(url, set);
  return set;
}

async function signingKey(config: AccessConfig, kid: string, fetchImpl: typeof fetch, now: number): Promise<CryptoKey | null> {
  let set = keySets.get(config.certsUrl);
  if (!set || now - set.fetchedAt > KEYS_TTL_MS) set = await fetchKeys(config.certsUrl, fetchImpl, now);
  // An unknown key id usually means Access rotated its keys.
  if (!set.keys.has(kid) && now - set.fetchedAt >= KEYS_REFRESH_MS) set = await fetchKeys(config.certsUrl, fetchImpl, now);
  const jwk = set.keys.get(kid);
  if (!jwk) return null;
  let key = set.imported.get(kid);
  if (!key) {
    const { kty, n, e } = jwk;
    // A published key that does not import verifies nothing, so its tokens are rejected rather than failing the request.
    key = crypto.subtle.importKey("jwk", { kty, n, e, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      .catch(() => null);
    set.imported.set(kid, key);
  }
  return key;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function jsonPart(value: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(value);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;

/**
 * The person an Access application token names, or null when the token is not a valid user token for this deployment:
 * malformed, not RS256, signed by an unknown key, issued by another team, meant for another application, expired, or
 * a service token (which carries no `sub` or `email`). Key fetch failures throw 503 instead of rejecting the person.
 */
export async function verifyAccessToken(token: string, config: AccessConfig, options: AccessOptions = {}): Promise<{ sub: string; email: string } | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = jsonPart(headerPart), payload = jsonPart(payloadPart), signature = base64UrlBytes(signaturePart);
  if (!header || !payload || !signature || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = options.now ?? Date.now();
  const key = await signingKey(config, header.kid, options.fetch ?? fetch, now);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) return null;

  const seconds = now / 1000;
  if (payload.iss !== config.teamDomain) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.some(value => typeof value === "string" && config.audiences.includes(value))) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds - CLOCK_SKEW_SECONDS) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > seconds + CLOCK_SKEW_SECONDS)) return null;
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > seconds + CLOCK_SKEW_SECONDS)) return null;

  const sub = text(payload.sub, 256), email = text(payload.email, 320);
  return sub && email ? { sub, email } : null;
}

/** The person Access signed in for this request, or null when no valid user token came with it. */
export async function accessUserFrom(requestHeaders: Headers, options: AccessOptions = {}): Promise<PlatformUser | null> {
  // Configuration is checked first, so a misconfigured deployment reports 503 even before anyone signs in.
  const config = accessConfigFrom(env);
  const token = requestHeaders.get(TOKEN_HEADER);
  if (!token) return null;
  const claims = await verifyAccessToken(token, config, options);
  // Access tokens carry no name, so the email is what the application displays.
  return claims ? { userId: claims.sub, email: claims.email, displayName: claims.email, fullName: null } : null;
}
