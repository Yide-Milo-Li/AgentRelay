import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getD1, getDb } from "@/server/db/client";
import { handoffs, projects } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { isUniqueViolation } from "@/server/core/sql-errors";
import { MAX_PROJECTS, type DeletedProject, type MergedProject, type Project, type ProjectLine } from "@/shared/contracts/projects";
import { defaultProjectLine, newProjectId, projectDisplayName, projectNameKey } from "@/shared/formatting/project-identity";
import { parseProjectLine, parseProjectName, parseVersion } from "./validation";

type Input = Record<string, unknown>;
type Row = typeof projects.$inferSelect;

const asProject = (row: Row): Project => ({ id: row.id, name: row.name, line: row.line as ProjectLine, archived: row.archivedAt != null,
  lastUsedAt: row.lastUsedAt, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.version });
const stale = () => new AgentRelayError("This project was just changed elsewhere. Refresh and try again.", 409);
const missing = () => new AgentRelayError("This project doesn't exist.", 404);
const tooMany = () => new AgentRelayError(`You can have up to ${MAX_PROJECTS} projects. Merge or delete some first.`, 409);

// Subqueries rather than ids read beforehand: when two senders create the same new project at once, both batches link
// their handoff to whichever row won the unique name key.
const idOf = (owner: string, key: string) => sql`(select id from projects where owner_id = ${owner} and name_key = ${key})`;
const nameOf = (owner: string, key: string) => sql`(select name from projects where owner_id = ${owner} and name_key = ${key})`;
/** True only while the project row still has the version the caller read. Batched writes use it as their CAS guard. */
const atVersion = (owner: string, id: string, version: number) =>
  sql`exists (select 1 from projects where owner_id = ${owner} and id = ${id} and version = ${version})`;

/** A project id, or failing that a name compared by key. */
async function findByRef(owner: string, ref: string): Promise<Row | undefined> {
  const id = ref.trim(), key = projectNameKey(projectDisplayName(ref));
  const rows = await getDb().select().from(projects)
    .where(and(eq(projects.ownerId, owner), or(eq(projects.id, id), key ? eq(projects.nameKey, key) : undefined))).limit(2);
  return rows.find(row => row.id === id) ?? rows[0];
}
async function requireProject(owner: string, id: string) {
  const [row] = await getDb().select().from(projects).where(and(eq(projects.ownerId, owner), eq(projects.id, id))).limit(1);
  if (!row) throw missing();
  return row;
}
async function usedLines(owner: string) {
  return (await getDb().select({ line: projects.line }).from(projects).where(eq(projects.ownerId, owner))).map(row => row.line as ProjectLine);
}

/**
 * Handoffs saved before the registry carry only a project name. File them under projects, creating any that are missing,
 * with the most recently used spelling as the name. Idempotent, so concurrent reads may both run it.
 */
async function reconcile(owner: string) {
  const db = getDb();
  const legacy = await db.select({ name: handoffs.project, last: sql<number>`max(${handoffs.createdAt})` }).from(handoffs)
    .where(and(eq(handoffs.ownerId, owner), isNull(handoffs.projectId), ne(handoffs.project, ""))).groupBy(handoffs.project).limit(100);
  if (!legacy.length) return;
  const existing = await db.select({ nameKey: projects.nameKey, line: projects.line }).from(projects).where(eq(projects.ownerId, owner));
  const known = new Set(existing.map(row => row.nameKey)), lines = existing.map(row => row.line as ProjectLine);
  const groups = new Map<string, { name: string; last: number; names: string[] }>();
  for (const { name, last } of legacy) {
    const key = projectNameKey(name);
    if (!key) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { name: projectDisplayName(name), last, names: [name] });
    else { group.names.push(name); if (last > group.last) Object.assign(group, { name: projectDisplayName(name), last }); }
  }
  const now = Date.now(), statements = [];
  for (const [key, group] of groups) {
    if (!known.has(key)) {
      if (known.size >= MAX_PROJECTS) continue;
      const line = defaultProjectLine(key, lines);
      known.add(key); lines.push(line);
      statements.push(db.insert(projects).values({ ownerId: owner, id: newProjectId(), name: group.name.slice(0, 120), nameKey: key, line,
        archivedAt: null, lastUsedAt: group.last, createdAt: now, updatedAt: now, version: 1 }).onConflictDoNothing());
    }
    statements.push(db.update(handoffs).set({ projectId: idOf(owner, key), project: nameOf(owner, key) })
      .where(and(eq(handoffs.ownerId, owner), isNull(handoffs.projectId), inArray(handoffs.project, group.names),
        sql`exists (select 1 from projects where owner_id = ${owner} and name_key = ${key})`)));
  }
  if (statements.length) await db.batch(statements as [typeof statements[number], ...typeof statements]);
}

export async function listProjects(owner: string): Promise<Project[]> {
  await reconcile(owner);
  const rows = await getDb().select().from(projects).where(eq(projects.ownerId, owner)).orderBy(desc(projects.lastUsedAt), asc(projects.name));
  return rows.map(asProject);
}

/** The project id a filter (id or name) refers to, or null when none matches. */
export async function resolveProjectFilter(owner: string, ref: string): Promise<string | null> {
  await reconcile(owner);
  return (await findByRef(owner, ref))?.id ?? null;
}

/** What a new handoff needs to join a project inside its own creation batch. */
export type ProjectLink = {
  key: string;
  /** Set when the project already existed while preparing; a brand-new one gets its id from `projectId` at write time. */
  existingId: string | null;
  /** Creates the project, or marks an existing one used (and unarchives it). Goes first in the caller's batch. */
  statement: D1PreparedStatement;
  /** Column values for the handoff row, resolved inside the batch. */
  projectId: SQL; projectName: SQL;
};

/** Resolve a handoff's project reference (id or name). Blank and non-string references mean no project. */
export async function prepareProjectLink(owner: string, ref: unknown, now: number): Promise<ProjectLink | null> {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const found = await findByRef(owner, ref);
  const { name, key } = found ? { name: found.name, key: found.nameKey } : parseProjectName(ref);
  let line = found?.line;
  if (!found) {
    const lines = await usedLines(owner);
    if (lines.length >= MAX_PROJECTS) throw tooMany();
    line = defaultProjectLine(key, lines);
  }
  const upsert = getDb().insert(projects).values({ ownerId: owner, id: newProjectId(), name, nameKey: key, line: line!,
    archivedAt: null, lastUsedAt: now, createdAt: now, updatedAt: now, version: 1 })
    // SQLite evaluates every assignment against the existing row, so the version bump still sees the old archived_at.
    .onConflictDoUpdate({ target: [projects.ownerId, projects.nameKey], set: {
      lastUsedAt: sql`excluded.last_used_at`, archivedAt: null,
      updatedAt: sql`case when ${projects.archivedAt} is null then ${projects.updatedAt} else excluded.updated_at end`,
      version: sql`${projects.version} + (${projects.archivedAt} is not null)`,
    } }).toSQL();
  return { key, existingId: found?.id ?? null, statement: getD1().prepare(upsert.sql).bind(...upsert.params),
    projectId: idOf(owner, key), projectName: nameOf(owner, key) };
}

export async function createProject(owner: string, input: Input): Promise<Project> {
  const { name, key } = parseProjectName(input.name);
  const lines = await usedLines(owner);
  if (lines.length >= MAX_PROJECTS) throw tooMany();
  const line = input.line == null ? defaultProjectLine(key, lines) : parseProjectLine(input.line), now = Date.now();
  try {
    const [created] = await getDb().insert(projects).values({ ownerId: owner, id: newProjectId(), name, nameKey: key, line,
      archivedAt: null, lastUsedAt: now, createdAt: now, updatedAt: now, version: 1 }).returning();
    return asProject(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AgentRelayError("A project with that name already exists.", 409);
    throw error;
  }
}

/** Rename, recolour, archive or unarchive. A rename rewrites the name snapshot on the project's handoffs in the same batch. */
export async function updateProject(owner: string, id: string, input: Input): Promise<Project> {
  const version = parseVersion(input);
  if (input.name === undefined && input.line === undefined && input.archived === undefined) throw new AgentRelayError("Change at least the name, the colour or whether it is archived.");
  if (input.archived !== undefined && typeof input.archived !== "boolean") throw new AgentRelayError("archived must be true or false.");
  const row = await requireProject(owner, id);
  if (row.version !== version) throw stale();
  const now = Date.now(), patch: Partial<Row> = { updatedAt: now, version: version + 1 };
  if (input.name !== undefined) {
    const { name, key } = parseProjectName(input.name);
    const other = await findByRef(owner, name);
    if (other && other.id !== id && other.nameKey === key) throw new AgentRelayError("A project with that name already exists. Merge the two projects instead.", 409);
    patch.name = name; patch.nameKey = key;
  }
  if (input.line !== undefined) patch.line = parseProjectLine(input.line);
  if (input.archived !== undefined) patch.archivedAt = input.archived ? row.archivedAt ?? now : null;
  const db = getDb(), update = db.update(projects).set(patch).where(and(eq(projects.ownerId, owner), eq(projects.id, id), eq(projects.version, version))).returning();
  try {
    const [updated] = patch.name === undefined ? await update : (await db.batch([
      db.update(handoffs).set({ project: patch.name }).where(and(eq(handoffs.ownerId, owner), eq(handoffs.projectId, id), atVersion(owner, id, version))),
      update,
    ]))[1];
    if (!updated) throw stale();
    return asProject(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AgentRelayError("A project with that name already exists. Merge the two projects instead.", 409);
    throw error;
  }
}

/** Move every handoff of one project into another and delete the emptied project, atomically. */
export async function mergeProject(owner: string, id: string, input: Input): Promise<MergedProject> {
  const version = parseVersion(input);
  if (typeof input.into !== "string" || !input.into) throw new AgentRelayError("Choose the project to merge into.");
  if (input.into === id) throw new AgentRelayError("A project can't be merged into itself.");
  const source = await requireProject(owner, id);
  if (source.version !== version) throw stale();
  const [target] = await getDb().select().from(projects).where(and(eq(projects.ownerId, owner), eq(projects.id, input.into))).limit(1);
  if (!target) throw new AgentRelayError("The project to merge into doesn't exist.", 404);
  // Both rows must still be as read: a concurrently deleted target would otherwise strand the moved handoffs.
  const db = getDb(), guard = and(atVersion(owner, id, version), sql`exists (select 1 from projects where owner_id = ${owner} and id = ${target.id})`);
  const [moved, [into], removed] = await db.batch([
    db.update(handoffs).set({ projectId: target.id, project: sql`(select name from projects where owner_id = ${owner} and id = ${target.id})` })
      .where(and(eq(handoffs.ownerId, owner), eq(handoffs.projectId, id), guard)).returning({ id: handoffs.id }),
    db.update(projects).set({ lastUsedAt: sql`max(${projects.lastUsedAt}, ${source.lastUsedAt})`, updatedAt: Date.now() })
      .where(and(eq(projects.ownerId, owner), eq(projects.id, target.id), guard)).returning(),
    db.delete(projects).where(and(eq(projects.ownerId, owner), eq(projects.id, id), eq(projects.version, version), guard)).returning({ id: projects.id }),
  ]);
  if (!removed.length || !into) throw stale();
  return { id, into: asProject(into), movedHandoffs: moved.length };
}

/** Delete a project; its handoffs stay and lose their project, so reconciling never brings the name back. */
export async function deleteProject(owner: string, id: string, input: Input): Promise<DeletedProject> {
  const version = parseVersion(input);
  const row = await requireProject(owner, id);
  if (row.version !== version) throw stale();
  const db = getDb();
  const [detached, removed] = await db.batch([
    db.update(handoffs).set({ projectId: null, project: "" })
      .where(and(eq(handoffs.ownerId, owner), eq(handoffs.projectId, id), atVersion(owner, id, version))).returning({ id: handoffs.id }),
    db.delete(projects).where(and(eq(projects.ownerId, owner), eq(projects.id, id), eq(projects.version, version))).returning({ id: projects.id }),
  ]);
  if (!removed.length) throw stale();
  return { id, detachedHandoffs: detached.length };
}
