"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/shared/http/client";
import { HANDOFF_LIST, type Handoff, type HandoffListItem, type HandoffListPage } from "@/shared/contracts/handoffs";
import { listItemOf, listPath, withWrite, type InboxQuery } from "../inbox-list";

const POLL_MS = 10_000;

/**
 * The inbox list for a query: summaries from the server, polled every ten seconds while the tab is visible. A poll asks
 * again for the rows already loaded and replaces them, so nothing is merged across requests; Show more appends the page
 * after the cursor. Every request is numbered, and an answer that a newer request (or a new query) overtook is dropped.
 */
export function useInboxList(query: InboxQuery) {
  const [rows, setRows] = useState<HandoffListItem[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState(0), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [connected, setConnected] = useState(false), [error, setError] = useState<unknown>(null);
  const key = JSON.stringify(query);
  const current = useRef({ query, key }), sequence = useRef(0), loaded = useRef<number>(HANDOFF_LIST.pageSize), cursor = useRef<string | null>(null);
  // Kept current before any effect runs, so a request always asks for the query on screen.
  useLayoutEffect(() => { current.current = { query, key }; });

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current, { query: asked } = current.current;
    try {
      const page = await api<HandoffListPage>(listPath(asked, { limit: Math.max(loaded.current, HANDOFF_LIST.pageSize) }));
      if (mine !== sequence.current) return;
      setRows(page.handoffs); setNextCursor(page.nextCursor); cursor.current = page.nextCursor; setOpenCount(page.counts.open);
      setConnected(true); setError(null);
    } catch (e) {
      if (mine === sequence.current) { setConnected(false); setError(e); }
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    const after = cursor.current;
    if (!after) return;
    const mine = ++sequence.current, { query: asked } = current.current;
    setLoadingMore(true);
    try {
      const page = await api<HandoffListPage>(listPath(asked, { limit: HANDOFF_LIST.pageSize, cursor: after }));
      if (mine !== sequence.current) return;
      setRows(old => {
        const known = new Set(old.map(row => row.id)), next = [...old, ...page.handoffs.filter(row => !known.has(row.id))];
        loaded.current = Math.min(next.length, HANDOFF_LIST.maxLimit);
        return next;
      });
      setNextCursor(page.nextCursor); cursor.current = page.nextCursor; setOpenCount(page.counts.open);
    } catch (e) {
      if (mine === sequence.current) setError(e);
    } finally { setLoadingMore(false); }
  }, []);

  // A new query starts again at one page; the old rows stay on screen until its answer arrives.
  useEffect(() => { loaded.current = HANDOFF_LIST.pageSize; void refresh(); }, [key, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  /** A record a write returned: its row is updated, or leaves the list when it no longer belongs there. */
  const applyWrite = useCallback((handoff: Handoff) => setRows(old => withWrite(old, handoff, current.current.query)), []);
  /** A new handoff goes to the top until the next poll places it. */
  const prepend = useCallback((handoff: Handoff) => setRows(old => [listItemOf(handoff), ...old.filter(row => row.id !== handoff.id)]), []);
  const remove = useCallback((id: string) => setRows(old => old.filter(row => row.id !== id)), []);
  return { rows, nextCursor, openCount, loading, loadingMore, connected, error, refresh, loadMore, applyWrite, prepend, remove };
}
