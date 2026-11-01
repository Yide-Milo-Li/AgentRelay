"use client";
import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { containDialogFocus, SHORTCUTS, type ShortcutId } from "@/shared/browser/keyboard-shortcuts";
import { ShortcutHint } from "@/components/ui/ShortcutHint";

type Props = { onClose: () => void };

export default function KeyboardShortcuts({ onClose }: Props) {
  const { t } = useLang();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected && previous.getClientRects().length
        ? previous : document.querySelector<HTMLElement>(".settings-button");
      target?.focus();
    };
  }, []);

  return <dialog ref={dialog} className="compose shortcut-dialog" aria-labelledby="shortcuts-title" aria-describedby="shortcuts-description"
    onKeyDown={event => containDialogFocus(event, dialog.current)}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="compose-head"><h2 id="shortcuts-title">{t.shortcutsTitle}</h2><button className="icon" aria-label={t.close} autoFocus onClick={onClose}><X size={18} /></button></div>
    <p id="shortcuts-description" className="muted">{t.shortcutsDescription}</p>
    <dl className="shortcut-list">{(Object.keys(SHORTCUTS) as ShortcutId[]).map(id => <div key={id}>
      <dt>{t.shortcutActions[id]}</dt><dd><ShortcutHint action={id} /></dd>
    </div>)}</dl>
  </dialog>;
}
