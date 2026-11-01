"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SetupRecord } from "./setup-progress";

// Browser storage is per origin, so this is per Site. Nothing here reaches the server.
const KEY = "agentrelay.setup.v1";
const listeners = new Set<() => void>();
// Holds the record for this tab when storage is blocked: the checklist still works, and a dismissal lasts for the tab.
let memory: string | null = null;

function read() {
  if (memory !== null) return memory;
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
function write(value: string) {
  memory = value;
  try { localStorage.setItem(KEY, value); } catch { /* The tab keeps it in memory. */ }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) { memory = null; listener(); } };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
function parse(raw: string): SetupRecord {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value as SetupRecord : {}; } catch { return {}; }
}
const add = (list: string[] | undefined, id: string) => list?.includes(id) ? list : [...(list ?? []), id];

/** This browser's setup record and the changes the checklist makes to it. */
export function useSetupRecord() {
  const raw = useSyncExternalStore(subscribe, read, () => "");
  const record = useMemo(() => parse(raw), [raw]);
  const change = useCallback((next: (old: SetupRecord) => SetupRecord) => write(JSON.stringify(next(parse(read())))), []);
  return {
    record,
    finish: useCallback(() => change(old => ({ ...old, done: true })), [change]),
    dismiss: useCallback(() => change(old => ({ ...old, dismissed: true })), [change]),
    /** Undo a dismissal, from Settings. */
    reopen: useCallback(() => change(old => ({ ...old, dismissed: false })), [change]),
    /** The person says the agent on `deviceId` uses the Site's plugin. */
    confirmPlugin: useCallback((deviceId: string) => change(old => ({ ...old, plugin: add(old.plugin, deviceId) })), [change]),
    /** Said from `deviceId`: another device is set up. */
    confirmOther: useCallback((deviceId: string) => change(old => ({ ...old, others: add(old.others, deviceId) })), [change]),
  };
}
