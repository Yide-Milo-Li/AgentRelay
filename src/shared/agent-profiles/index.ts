import data from "./profiles.json";
import { fillValues } from "./site-url.mjs";

/**
 * Everything that differs between agents lives in one profile (profiles.json); the server never branches on it.
 * `config.template` is the agent's config file content, with `{siteUrl}` standing for the deployed origin and
 * secrets only ever written as `${ENV_VAR}` references. `cli`, when present, lets the setup script register
 * the connection itself; `{entry}` stands for the JSON found at `config.entryPath`.
 */
export type AgentProfile = {
  id: string;
  label: string;
  description: { en: string; zh: string };
  /** Where the agent reads user-level instructions; the device rule is pasted there. */
  ruleFile: string;
  /** Where the setup script installs the agentrelay skill for a device-bound connection (the agent's user skill folder). */
  skillDir?: string;
  /** How a person invokes the skill by name in this agent (`/agentrelay`, or `$agentrelay` in Codex). */
  skillCommand?: string;
  /**
   * The agent also reads another agent's skill folder after its own (DeepSeek Harness reads `~/.agents/skills`), so a
   * connection without the skill gets a placeholder `agentrelay` skill in its folder that shadows that copy.
   */
  skillPlaceholder?: boolean;
  /** The two variables the person sets in the terminal before running the setup command (inputs, never stored by it). */
  secrets: readonly string[];
  /** Variables `--persist-env` saves for the agent to read, with `{agentToken}` and `{gatewayToken}` filled in. */
  persist: Readonly<Record<string, string>>;
  /**
   * The agent's home directory, when an environment variable can move it: paths under `path` are re-rooted at the
   * variable's value when it is set.
   */
  home?: { variable: string; path: string };
  /**
   * `template` is a JSON value (rendered as JSON) or a string (such as a TOML table or a YAML patch row). `entryPath`
   * marks the part handed to a CLI; `file` and `table` (TOML) or `rowId` (YAML) name what the setup script edits
   * when there is no CLI.
   */
  config: { format?: string; file?: string; table?: string; rowId?: string; entryPath?: readonly string[]; template: unknown };
  /** The agent starts the local stdio bridge, which reads the tokens from the environment it inherits; the config holds none. */
  bridge?: boolean;
  /**
   * Bridge adjustments for agents that cannot use the Site's MCP answers as they are. `core-schemas`: the agent rejects
   * tool parameter schemas outside a small JSON Schema subset, so the bridge reduces them. `initialize-only`: the bridge
   * refuses `server/discover`, so the agent's SDK falls back to the `initialize` handshake.
   */
  bridgeCompatibility?: readonly ("core-schemas" | "initialize-only")[];
  /**
   * `remove` clears an earlier registration first, so running the setup again replaces it instead of failing.
   * `args` may also use `{endpoint}` and `{bridgePath}`, which the setup script fills in.
   */
  cli?: { command: string; remove?: readonly string[]; args: readonly string[]; missing: string };
};

// The JSON is validated by tests/unit/agent-profiles.test.mjs; its inferred union of shapes cannot be assigned directly.
export const AGENT_PROFILES = data.profiles as unknown as readonly AgentProfile[];
export const DEFAULT_AGENT_PROFILE: AgentProfile = AGENT_PROFILES[0];

export function findAgentProfile(id: string): AgentProfile | undefined {
  return AGENT_PROFILES.find(profile => profile.id === id);
}

/** Shown in the web app, which cannot know where the repository is checked out on the device. */
export const BRIDGE_PATH_PLACEHOLDER = "<path-to-agentrelay>/scripts/agents/mcp-bridge.mjs";

export function renderConfig(profile: AgentProfile, siteUrl: string): unknown {
  return fillValues(profile.config.template, { siteUrl, bridgePath: BRIDGE_PATH_PLACEHOLDER });
}

/** The text shown to the user and written by the agent's own config tooling. */
export function renderConfigText(profile: AgentProfile, siteUrl: string): string {
  const config = renderConfig(profile, siteUrl);
  return typeof config === "string" ? config : JSON.stringify(config, null, 2);
}
