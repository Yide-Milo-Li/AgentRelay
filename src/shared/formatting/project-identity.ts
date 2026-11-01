import type { Project, ProjectLine } from "@/shared/contracts/projects";

// Pure helpers shared by the browser and the server, so both sides agree on when two project names are the same.

/**
 * NFKC, lowercased, with whitespace and the separators `-`, `_` and `.` removed, so `agent-relay`, `Agent Relay` and
 * `AgentRelay` are one project. Empty when the name has no letter or digit left.
 */
export function projectNameKey(name: string) {
  return name.normalize("NFKC").toLowerCase().replace(/[\s\-_.]+/g, "");
}

/** The stored display form: trimmed, inner whitespace collapsed. */
export function projectDisplayName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Opaque ids: agents address projects by name, so the id never has to be readable. */
export function newProjectId() {
  return `p-${Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => BASE32[byte % 32]).join("")}`;
}

const AUTO_LINES: readonly ProjectLine[] = ["blue", "amber", "green", "violet", "teal", "brown"];

/** The least used colour, ties broken by a stable hash of the name key so a project keeps the same pick. Never neutral. */
export function defaultProjectLine(key: string, used: Iterable<ProjectLine>): ProjectLine {
  const counts = new Map<ProjectLine, number>(AUTO_LINES.map(line => [line, 0]));
  for (const line of used) if (counts.has(line)) counts.set(line, counts.get(line)! + 1);
  const fewest = Math.min(...counts.values());
  const candidates = AUTO_LINES.filter(line => counts.get(line) === fewest);
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return candidates[hash % candidates.length];
}

export type ProjectIndex = { projects: readonly Project[]; byId: ReadonlyMap<string, Project>; byKey: ReadonlyMap<string, Project> };

export function indexProjects(projects: readonly Project[]): ProjectIndex {
  return { projects, byId: new Map(projects.map(project => [project.id, project])), byKey: new Map(projects.map(project => [projectNameKey(project.name), project])) };
}
export const EMPTY_PROJECT_INDEX = indexProjects([]);

/** How a handoff's project is shown; null when it has none. */
export type ProjectRef = { id: string | null; name: string; line: ProjectLine; archived: boolean };

/**
 * Resolve by id first, then by name key, which covers rows filed under a project after the registry was fetched.
 * A name the registry does not know yet keeps its text and a colour hashed from its key.
 */
export function resolveProject(index: ProjectIndex, id: string | null | undefined, name: string): ProjectRef | null {
  const found = (id ? index.byId.get(id) : undefined) ?? (name ? index.byKey.get(projectNameKey(name)) : undefined);
  if (found) return { id: found.id, name: found.name, line: found.line, archived: found.archived };
  return name ? { id: null, name, line: defaultProjectLine(projectNameKey(name), []), archived: false } : null;
}
