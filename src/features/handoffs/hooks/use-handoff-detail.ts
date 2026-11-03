"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/shared/http/client";
import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import type { Handoff } from "@/shared/contracts/handoffs";

/** What the list knows about the selected handoff: enough to tell whether a remembered record is still current. */
export type DetailHint = { version: number; updatedAt: number };

// Records read in this visit, newest last; the oldest are dropped past this many.
const REMEMBERED = 100;

/**
 * The full record of the selected handoff, read one handoff at a time. A remembered record is shown at once and reused
 * while the list row's version and update time match it; it is read again when they differ. Records a write returned
 * are remembered too, so the pane shows them in the same render. `missing` names an id the server no longer has.
 */
export function useHandoffDetail(id: string | null, hint: DetailHint | null, enabled: boolean) {
  const [records, setRecords] = useState<ReadonlyMap<string, Handoff>>(new Map());
  const [missing, setMissing] = useState<string | null>(null), [error, setError] = useState<unknown>(null);
  const remember = useCallback((record: Handoff) => setRecords(old => {
    const next = new Map(old);
    next.delete(record.id); next.set(record.id, record);
    for (const oldest of next.keys()) { if (next.size <= REMEMBERED) break; next.delete(oldest); }
    return next;
  }), []);
  const cached = id ? records.get(id) ?? null : null;
  const version = hint?.version, updatedAt = hint?.updatedAt;
  // Without a list row (a link, a thread entry) a remembered record is the best there is.
  const stale = !!id && (!cached || (version !== undefined && (cached.version !== version || cached.updatedAt !== updatedAt)));
  useEffect(() => {
    if (!id || !enabled || !stale) return;
    let active = true;
    api<Handoff>(`/api/handoffs/${encodeURIComponent(id)}`).then(record => {
      remember(record);
      if (active) setError(null);
    }, e => {
      if (!active) return;
      if (e instanceof AgentRelayClientError && e.status === 404) setMissing(id); else setError(e);
    });
    return () => { active = false; };
  }, [id, enabled, stale, version, updatedAt, remember]);
  const forget = useCallback((gone: string) => setRecords(old => { const next = new Map(old); next.delete(gone); return next; }), []);
  /** Read a handoff by id, from a notification, a thread entry or a link, before it is selected. */
  const open = useCallback(async (target: string): Promise<Handoff | null> => {
    try {
      const record = await api<Handoff>(`/api/handoffs/${encodeURIComponent(target)}`);
      remember(record); setMissing(null);
      return record;
    } catch (e) {
      if (e instanceof AgentRelayClientError && e.status === 404) { setMissing(target); return null; }
      throw e;
    }
  }, [remember]);
  return { detail: cached, missing: missing && missing === id ? missing : null, error, store: remember, forget, open };
}
