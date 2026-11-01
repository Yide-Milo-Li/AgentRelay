/**
 * Pure planning for the local D1 migration runner. A ledger table records applied
 * migrations; databases migrated by hand before the ledger existed are recognised by
 * probing their schema, so the runner never replays a migration they already contain.
 */
export const LEDGER_TABLE = "_agentrelay_migrations";

/** One query per hand-applied migration; a row with `present = 1` means its change is already in the schema. */
export const LEGACY_PROBES = {
  "0000_curious_nuke": "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'",
  "0001_odd_steve_rogers": "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_tokens'",
  "0002_public_mac_gargan": "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
  "0003_right_zzzax": "SELECT count(*) AS present FROM sqlite_master WHERE type = 'index' AND name = 'handoffs_owner_storage'",
  "0004_broken_princess_powerful": "SELECT count(*) AS present FROM pragma_table_info('agent_tokens') WHERE name = 'created_by_user_id'",
};

/**
 * @param {string[]} journalTags Migration tags in journal order.
 * @param {string[]|null} ledgerTags Recorded tags, or null when the ledger table does not exist yet.
 * @param {Record<string, boolean>} legacyPresent Probe results; only read when the ledger is missing.
 * @returns {{ baseline: string[], apply: string[] }} Tags to record without running, and tags to run.
 */
export function planMigrations(journalTags, ledgerTags, legacyPresent = {}) {
  const baseline = [];
  if (ledgerTags === null) {
    // Hand-applied migrations form a prefix of the journal; stop at the first one the schema lacks.
    for (const tag of journalTags) {
      if (!(tag in LEGACY_PROBES) || !legacyPresent[tag]) break;
      baseline.push(tag);
    }
  }
  const done = new Set([...(ledgerTags ?? []), ...baseline]);
  return { baseline, apply: journalTags.filter((tag) => !done.has(tag)) };
}

/** Migration SQL followed by its ledger row, so a crash cannot leave one without the other. */
export function withLedgerRow(sql, tag, appliedAt) {
  const body = sql.trimEnd();
  const terminated = body.endsWith(";") ? body : `${body};`;
  return `${terminated}\nINSERT INTO ${LEDGER_TABLE} (tag, applied_at) VALUES ('${tag}', ${appliedAt});\n`;
}
