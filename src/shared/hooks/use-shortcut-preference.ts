"use client";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agentrelay.character-shortcuts.v1";
const listeners = new Set<() => void>();
let memory: boolean | null = null;

function read() {
  if (memory !== null) return memory;
  try { return localStorage.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) { memory = null; listener(); }
  };
  listeners.add(listener);
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}

function write(enabled: boolean) {
  memory = enabled;
  try { localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off"); } catch { /* Keep the switch usable when storage is blocked. */ }
  listeners.forEach(listener => listener());
}

export function useShortcutPreference() {
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  return [enabled, write] as const;
}
