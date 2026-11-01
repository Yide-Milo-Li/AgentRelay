"use client";
import { useEffect, useState } from "react";
import { api } from "@/shared/http/client";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { isRetired } from "@/shared/formatting/connection-health";

/**
 * How many usable connections each device has, for views that only show a number. `null` until the first answer; a
 * failed load leaves it `null`, so no wrong count is ever shown. `reloadKey` asks for a fresh answer when it changes.
 */
export function useConnectionCounts(enabled: boolean, reloadKey: unknown): ReadonlyMap<string, number> | null {
  const [counts, setCounts] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api<{ tokens: TokenInfo[] }>("/api/agent-tokens").then(result => {
      if (!current) return;
      const now = Date.now(), byDevice = new Map<string, number>();
      for (const token of result.tokens) if (token.deviceId && !isRetired(token, now)) byDevice.set(token.deviceId, (byDevice.get(token.deviceId) ?? 0) + 1);
      setCounts(byDevice);
    }, () => { if (current) setCounts(null); });
    return () => { current = false; };
  }, [enabled, reloadKey]);
  return counts;
}
