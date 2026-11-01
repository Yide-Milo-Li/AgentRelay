// Test-only D1 and R2 doubles backed by node:sqlite, so the real SQL of the services runs against the real migrations.
// `batch` is transactional like D1's: any failing statement rolls the whole sequence back.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

export function openDatabase() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(projectRoot, "drizzle");
  for (const file of readdirSync(dir).filter(name => name.endsWith(".sql")).sort())
    for (const statement of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
  return db;
}

export function createD1(db, hooks = {}) {
  const run = (sql, params) => {
    const statement = db.prepare(sql);
    if (statement.columns().length) { const rows = statement.all(...params); return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } }; }
    const info = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  };
  const make = (sql, params = []) => ({
    sql, params, bind: (...values) => make(sql, values.map(value => value === undefined ? null : value)),
    all: async () => run(sql, params), run: async () => run(sql, params),
    first: async () => run(sql, params).results[0] ?? null,
    raw: async () => run(sql, params).results.map(row => Object.values(row)),
  });
  return {
    prepare: sql => make(sql),
    async batch(statements) {
      hooks.beforeBatch?.(statements.map(statement => statement.sql));
      db.exec("BEGIN");
      try {
        const results = statements.map(statement => run(statement.sql, statement.params));
        db.exec("COMMIT");
        return results;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
export class FakeBucket {
  objects = new Map();
  failDeletes = false;
  failPuts = false;
  async put(key, bytes) {
    if (this.failPuts) throw new Error("simulated R2 outage");
    this.objects.set(key, new Uint8Array(bytes));
  }
  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer } : null;
  }
  /** Like R2: one key or a list of keys, and a missing key is not an error. */
  deleteCalls = 0;
  async delete(keys) {
    this.deleteCalls++;
    if (this.failDeletes) throw new Error("simulated R2 outage");
    for (const key of [keys].flat()) this.objects.delete(key);
  }
}
