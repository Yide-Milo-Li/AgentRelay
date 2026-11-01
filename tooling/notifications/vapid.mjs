// Generate the VAPID key pair a Site needs before it can send browser notifications. The private key is a secret: nothing
// here logs it, and a file for it is refused inside the repository so it cannot be committed by accident.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../environment/project-root.mjs";

const encode = bytes => Buffer.from(bytes).toString("base64url");

/** A VAPID contact is an https address (normally the Site's own) or a mailto address; the push service may use it to reach the operator. */
export function vapidSubjectOf(value) {
  if (typeof value !== "string") throw new Error("A subject is required: an https address or a mailto address.");
  const subject = value.trim();
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return subject;
  let url;
  try { url = new URL(subject); } catch { /* Reported below. */ }
  if (url?.protocol === "https:" && url.hostname && !url.username && !url.password && !/\s/.test(subject)) return subject;
  throw new Error("The subject must be an https address or a mailto address, for example https://<your-site>.chatgpt.site or mailto:you@example.com.");
}

/** The four runtime values, in the order they are documented. The public key is the raw uncompressed point; the private key is the scalar. */
export async function generateVapid(subject) {
  const checked = vapidSubjectOf(subject);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    AGENTRELAY_WEB_PUSH_ENABLED: "1",
    AGENTRELAY_VAPID_PUBLIC_KEY: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
    AGENTRELAY_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d,
    AGENTRELAY_VAPID_SUBJECT: checked,
  };
}

export const formatEnv = values => `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;

/** Creates the file only if it is new, readable by its owner alone, and nowhere inside this checkout. */
export function writeEnvFile(file, values, root = projectRoot) {
  const resolved = path.resolve(file), relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Choose a file outside the repository, so the private key cannot be committed.");
  try { writeFileSync(resolved, formatEnv(values), { flag: "wx", mode: 0o600 }); }
  catch (error) { throw new Error(error.code === "EEXIST" ? "That file already exists; choose a new path." : `Cannot write the file: ${error.code ?? "unknown error"}.`); }
  return resolved;
}
