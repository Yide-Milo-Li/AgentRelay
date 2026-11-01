// One definition supplies matching, visible hints, and assistive-technology labels.
export const SHORTCUTS = {
  tabInbox: { key: "1", label: "1", aria: "1" },
  tabDone: { key: "2", label: "2", aria: "2" },
  tabDevices: { key: "3", label: "3", aria: "3" },
  tabAgents: { key: "4", label: "4", aria: "4" },
  tabSettings: { key: "5", label: "5", aria: "5" },
  search: { key: "/", label: "/", aria: "/" },
  create: { key: "n", label: "N", aria: "n" },
  next: { key: "j", label: "J", aria: "j" },
  previous: { key: "k", label: "K", aria: "k" },
  open: { key: "Enter", label: "Enter", aria: "Enter" },
  copy: { key: "y", label: "Y", aria: "y" },
  claim: { key: "c", shift: true, label: "Shift + C", aria: "Shift+c" },
  complete: { key: "d", shift: true, label: "Shift + D", aria: "Shift+d" },
  undo: { key: "z", label: "Ctrl / ⌘ + Z", aria: "Control+z Meta+z" },
  send: { key: "Enter", label: "Ctrl / ⌘ + Enter", aria: "Control+Enter Meta+Enter" },
  help: { key: "?", label: "?", aria: "Shift+/" },
  escape: { key: "Escape", label: "Esc", aria: "Escape" },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;
type Key = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented">;
type Context = { characters: boolean; editing: boolean; blocked: boolean };

export function matchesShortcut(id: ShortcutId, event: Key, context: Context): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || context.blocked) return false;
  const shortcut = SHORTCUTS[id], chord = id === "send" || id === "undo";
  if (shortcut.key.length === 1 && !chord && (!context.characters || context.editing)) return false;
  // Text fields keep their own undo history.
  if ((id === "open" || id === "undo") && context.editing) return false;
  const requiresShift = "shift" in shortcut && shortcut.shift;
  if (event.altKey || (id !== "help" && event.shiftKey !== requiresShift)) return false;
  if (chord) {
    // AltGr and mixed modifier chords must never send a prompt or change a status.
    return event.key.toLowerCase() === shortcut.key.toLowerCase() && event.ctrlKey !== event.metaKey;
  }
  return !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === shortcut.key.toLowerCase();
}

export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]');
}

export function hasShortcutLayer(): boolean {
  // A menu inside the hidden mobile pane must not disable the visible list's shortcuts.
  return Array.from(document.querySelectorAll("dialog[open], [data-shortcut-layer]")).some(element => element.getClientRects().length > 0);
}

/** Native modal inertness does not wrap Tab at the edges in every browser. */
export function containDialogFocus(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "preventDefault">, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || !dialog) return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.getClientRects().length && !element.closest("[inert]"));
  const first = controls[0], last = controls[controls.length - 1];
  const active = document.activeElement;
  if (!first || active === dialog || !dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}

export function adjacentItemIndex(length: number, current: number, direction: -1 | 1): number | null {
  if (!length) return null;
  return current < 0 ? 0 : Math.max(0, Math.min(length - 1, current + direction));
}
