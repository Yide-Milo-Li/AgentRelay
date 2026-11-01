"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/shared/http/client";
import type { StorageSummary } from "@/shared/contracts/storage";

export function useStorageSummary(active: boolean, enabled: boolean) {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    // A post-mutation refresh replaces any older measurement rather than accepting a stale response.
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    return api<StorageSummary>("/api/storage", "GET", undefined, { signal: current.signal }).then(value => {
      if (!current.signal.aborted) { setSummary(value); setError(null); }
    }, failure => { if (!current.signal.aborted) setError(failure); });
  }, [enabled]);
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, [refresh]);
  useEffect(() => {
    if (!active || !enabled) return;
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    visible();
    const timer = setInterval(visible, 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, enabled, refresh]);
  return { summary, error, refresh };
}
