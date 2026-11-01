import { AgentRelayError } from "@/server/core/agent-relay-error";
import { DEVICE_LINES } from "@/shared/contracts/devices";
import { PROJECT_NAME_MAX, type ProjectLine } from "@/shared/contracts/projects";
import { projectDisplayName, projectNameKey } from "@/shared/formatting/project-identity";

type Input = Record<string, unknown>;

/** Display name plus the key sameness is judged by. Whitespace (tabs and newlines included) collapses to one space first. */
export function parseProjectName(value: unknown) {
  if (typeof value !== "string") throw new AgentRelayError(`Project names must be 1–${PROJECT_NAME_MAX} characters.`);
  const name = projectDisplayName(value);
  if (name.length > PROJECT_NAME_MAX) throw new AgentRelayError("Project names are limited to 120 characters.");
  if (!name || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new AgentRelayError(`Project names must be 1–${PROJECT_NAME_MAX} characters.`);
  const key = projectNameKey(name);
  if (!key) throw new AgentRelayError("Project names need at least one letter or digit.");
  return { name, key };
}

export function parseProjectLine(value: unknown): ProjectLine {
  if (typeof value !== "string" || !(DEVICE_LINES as readonly string[]).includes(value)) throw new AgentRelayError("That line colour isn't available.");
  return value as ProjectLine;
}

export function parseVersion(input: Input, key = "version") {
  if (!Number.isInteger(input[key]) || Number(input[key]) < 1) throw new AgentRelayError("The latest version is required.");
  return Number(input[key]);
}
