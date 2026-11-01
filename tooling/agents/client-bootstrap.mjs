// The entry behind scripts/agents/agentrelay.mjs. Inside an installed client or a Release folder it runs the client
// directly. In a repository checkout it first installs this checkout's client version into ~/.agentrelay and hands the
// command to that copy, so the OS keyring addon always loads from the installed client and a checkout without
// `npm run install:ci` still works. Nothing here loads the keyring.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ClientError } from "./credential-store.mjs";
import { ensureClient } from "./client-install.mjs";

/** An installed client and a Release folder carry the client's own package manifest; a checkout carries the app's. */
export function isClientCopy(root) {
  try { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "agentrelay-client"; } catch { return false; }
}

// Commands that need no credentials, so the checkout runs them itself and installs nothing: help, and the read-only
// Git helpers the skill calls.
const LOCAL_COMMANDS = new Set([undefined, "help", "--help", "-h", "context", "check-base"]);

/**
 * Run `args` for the entry at `root`. The handover keeps stdio, so hidden input still reads the terminal, and passes
 * the same arguments, which never contain a credential. The exit code is the installed client's.
 */
export async function runEntry(args, root, { ensure = ensureClient, run = spawnSync } = {}) {
  if (isClientCopy(root) || LOCAL_COMMANDS.has(args[0])) {
    const { main } = await import("./client.mjs");
    return main(args);
  }
  let versionRoot;
  try { versionRoot = ensure({ source: root }); }
  catch (e) {
    console.error(`AgentRelay: ${e instanceof ClientError ? e.message : "Could not install the local client. Check file permissions in your home folder."}`);
    process.exitCode = 1; return;
  }
  const result = run(process.execPath, [path.join(versionRoot, "scripts/agents/agentrelay.mjs"), ...args], { stdio: "inherit" });
  process.exitCode = result.error ? 1 : result.status ?? 1;
}
