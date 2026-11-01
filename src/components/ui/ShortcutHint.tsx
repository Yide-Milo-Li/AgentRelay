import { SHORTCUTS, type ShortcutId } from "@/shared/browser/keyboard-shortcuts";

export function ShortcutHint({ action }: { action: ShortcutId }) {
  return <kbd className="shortcut-hint" aria-hidden="true">{SHORTCUTS[action].label}</kbd>;
}
