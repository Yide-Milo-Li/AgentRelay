"use client";
import { useEffect, useRef } from "react";
import { hasShortcutLayer, isTextEntry, matchesShortcut, type ShortcutId } from "@/shared/browser/keyboard-shortcuts";

type Bindings = Partial<Record<ShortcutId, (event: KeyboardEvent) => boolean>>;
type Options = { characters?: boolean; enabled?: boolean; withinLayer?: boolean };

/** Returning true consumes the event; false leaves it to the focused control or another layer. */
export function useKeyboardShortcuts(bindings: Bindings, { characters = true, enabled = true, withinLayer = false }: Options = {}) {
  const composing = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; };
    const keydown = (event: KeyboardEvent) => {
      if (composing.current) return;
      const context = { characters, editing: isTextEntry(event.target), blocked: !withinLayer && hasShortcutLayer() };
      for (const id of Object.keys(bindings) as ShortcutId[]) {
        if (matchesShortcut(id, event, context) && bindings[id]?.(event)) {
          event.preventDefault();
          return;
        }
      }
    };
    // Bubble after React's control handlers so an inner layer can consume Escape first.
    window.addEventListener("keydown", keydown);
    window.addEventListener("compositionstart", start);
    window.addEventListener("compositionend", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("compositionstart", start);
      window.removeEventListener("compositionend", end);
      window.removeEventListener("blur", end);
    };
  }, [bindings, characters, enabled, withinLayer]);
}
