"use client";
import { useEffect, useState } from "react";
import { api } from "@/shared/http/client";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { isRetired } from "@/shared/formatting/connection-health";

/**
 * The devices that have a usable connection whose credential has been used at least once: the server's evidence that
 * an agent was set up there. Revoked and expired connections never count. `null` until the first answer and after a
 * failed one. While `enabled`, it reads again every `intervalMs` the tab is visible, so a `connect` run elsewhere shows up.
 */
export function useConnectedDevices(enabled: boolean, intervalMs = 10_000): ReadonlySet<string> | null {
  const [devices, setDevices] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () => api<{ tokens: TokenInfo[] }>("/api/agent-tokens").then(result => {
      if (!current) return;
      const now = Date.now();
      const next = new Set(result.tokens.filter(token => token.deviceId && token.lastAuthenticatedAt && !isRetired(token, now)).map(token => token.deviceId as string));
      // An unchanged answer keeps the same set, so a poll re-renders nothing.
      setDevices(old => old && old.size === next.size && [...next].every(id => old.has(id)) ? old : next);
    }, () => { if (current) setDevices(null); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, intervalMs);
    return () => { current = false; clearInterval(timer); };
  }, [enabled, intervalMs]);
  return devices;
}
