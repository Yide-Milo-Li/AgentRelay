// Local Node tooling only. The Worker never imports the native credential library.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class ClientError extends Error {}
export const clientHome = () => path.join(os.homedir(), ".agentrelay");
export const siteKey = origin => createHash("sha256").update(origin).digest("hex").slice(0, 24);
export const envName = ref => `AGENTRELAY_${ref.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
export const credentialRefs = (origin, id) => ({ agent: `connection-${id}`, gateway: `site-${siteKey(origin)}` });

export function readManifest(home = clientHome()) {
  try {
    const value = JSON.parse(readFileSync(path.join(home, "connections.json"), "utf8"));
    if (value.version !== 1 || !value.connections || typeof value.connections !== "object") throw new ClientError();
    return value;
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, connections: {} };
    throw new ClientError("Cannot read the local connection manifest. Restore connections.json from its backup.");
  }
}
export function saveManifest(manifest, home = clientHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "connections.json"), temp = `${file}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

/** Pin Linux to persistent Secret Service; its absence must never silently choose a memory-only backend. */
export async function systemStore() {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const entry = ref => new Entry("AgentRelay", ref, { linux: { store: "secret-service" } });
    return {
      get: ref => entry(ref).getPassword(), set: (ref, value) => entry(ref).setPassword(value),
      remove: ref => entry(ref).deleteCredential(),
    };
  } catch {
    throw new ClientError("The OS credential store is unavailable. Unlock it/install Secret Service, or explicitly choose --storage env. No fallback was made.");
  }
}

export async function readConnection(id, { home = clientHome(), env = process.env, store } = {}) {
  const record = readManifest(home).connections[id];
  if (!record || record.id !== id) throw new ClientError("Unknown local connection. Run connect on this device first.");
  let agentToken, gatewayToken;
  try {
    if (record.storage === "env") {
      agentToken = env[envName(record.credentialRef)]; gatewayToken = env[envName(record.gatewayRef)];
    } else {
      const vault = store ?? await systemStore();
      agentToken = vault.get(record.credentialRef); gatewayToken = vault.get(record.gatewayRef);
    }
  } catch { throw new ClientError("Cannot read this connection's credentials. Unlock the OS credential store and reconnect."); }
  if (!/^agentrelay_[a-f0-9]{64}$/i.test(agentToken ?? "") || !gatewayToken)
    throw new ClientError("This connection's credentials are missing. Re-run connect; environment storage also needs a restarted terminal and agent.");
  return { record, agentToken, gatewayToken };
}

export const authHeaders = ({ agentToken, gatewayToken }) => ({
  Authorization: `Bearer ${agentToken}`, "OAI-Sites-Authorization": `Bearer ${gatewayToken}`,
});
