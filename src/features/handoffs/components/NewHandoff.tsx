"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, ArrowRight, LockKeyhole, TriangleAlert } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import { HANDOFF_LIMITS, type Handoff } from "@/shared/contracts/handoffs";
import { replyTitle } from "@/shared/formatting/reply-title";
import { ANY_DEVICE_ID } from "@/shared/contracts/devices";
import { isReservedDeviceName, lookupDevice, type DeviceIndex } from "@/shared/formatting/device-identity";
import type { ProjectIndex } from "@/shared/formatting/project-identity";
import DeviceCombobox from "./DeviceCombobox";
import ProjectCombobox from "./ProjectCombobox";
import AttachmentTray from "./AttachmentTray";
import { useAttachmentUploads } from "../hooks/use-attachment-uploads";
import { useKeyboardShortcuts } from "@/shared/hooks/use-keyboard-shortcuts";
import { containDialogFocus, SHORTCUTS } from "@/shared/browser/keyboard-shortcuts";
import { ShortcutHint } from "@/components/ui/ShortcutHint";

type Props = {
  device: string;
  isCurrentRegistered: boolean;
  devices: DeviceIndex;
  projects: ProjectIndex;
  sourceSuggestions: readonly string[];
  targetSuggestions: readonly string[];
  defaultTarget: string;
  onClose: () => void;
  onCreated: (row: Handoff) => void;
  onChooseDevice?: () => void;
  /** Compose a reply: the new handoff joins this one's thread. The caller passes its sender as `defaultTarget` and its project as `defaultProject`. */
  replyTo?: { id: string; title: string } | null;
  defaultProject?: string;
};
// A registered device is sent by id so a later rename can't break the route; anything else is sent as typed.
const deviceRef = (devices: DeviceIndex, value: unknown) => lookupDevice(devices, String(value))?.id ?? String(value);
export default function NewHandoff({ device, isCurrentRegistered, devices, projects, sourceSuggestions, targetSuggestions, defaultTarget, onClose, onCreated, onChooseDevice, replyTo = null, defaultProject = "" }: Props) {
  const { t, errorText } = useLang();
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null), sendButton = useRef<HTMLButtonElement>(null), continueButton = useRef<HTMLButtonElement>(null);
  const initialForm = useRef(""), lastField = useRef<HTMLElement | null>(null), inFlight = useRef(false), composing = useRef(false);
  const restoreEditing = useRef(false), failedFocus = useRef<HTMLElement | null>(null);
  // A retry reuses the request key only while the payload is identical; an edit after a failure needs a fresh one.
  const attempt = useRef<{ key: string; signature: string } | null>(null);
  const uploads = useAttachmentUploads(true), [dragging, setDragging] = useState(false);
  // The unsaved-change check reads the image set through a ref so the mount-time snapshot and later ones agree.
  const imageSignature = useRef("");
  useEffect(() => { imageSignature.current = uploads.summary.signature; }, [uploads.summary.signature]);
  const imageCount = uploads.summary.total;
  const [saving, setSaving] = useState(false), [error, setError] = useState<unknown>(null);
  const [discard, setDiscard] = useState(false);
  const [content, setContent] = useState("");
  const [from, setFrom] = useState(device);
  const [to, setTo] = useState(defaultTarget);
  // Empty means no project; a new handoff never preselects one, while a reply starts in its parent's project.
  const [project, setProject] = useState(defaultProject);
  function snapshot() { return form.current ? JSON.stringify([Array.from(new FormData(form.current).entries()), imageSignature.current]) : ""; }
  useLayoutEffect(() => {
    const element = dialog.current;
    const preventNativeClose = (event: Event) => event.preventDefault();
    initialForm.current = snapshot();
    element?.addEventListener("cancel", preventNativeClose);
    element?.showModal();
    form.current?.querySelector<HTMLElement>('[name="title"]')?.focus();
    return () => { element?.removeEventListener("cancel", preventNativeClose); element?.close(); };
  }, []);
  useLayoutEffect(() => {
    if (discard) continueButton.current?.focus();
    else if (restoreEditing.current) {
      restoreEditing.current = false;
      const previous = lastField.current;
      (previous?.isConnected && !previous.matches(":disabled") ? previous : form.current?.querySelector<HTMLElement>('[name="title"]'))?.focus();
    }
  }, [discard]);
  useLayoutEffect(() => {
    if (!saving && failedFocus.current) {
      if (failedFocus.current.isConnected) failedFocus.current.focus();
      failedFocus.current = null;
    }
  }, [saving]);

  function requestClose() {
    if (inFlight.current || discard) return;
    if (snapshot() === initialForm.current) { onClose(); return; }
    lastField.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDiscard(true);
  }
  function continueEditing() {
    // Focus only after React re-enables the fieldset, including native dialog cancel events.
    restoreEditing.current = true;
    setDiscard(false);
  }
  useKeyboardShortcuts({ send: event => {
    if (!(event.target instanceof Node) || !form.current?.contains(event.target)) return false;
    if (!inFlight.current && !discard && sendButton.current && !sendButton.current.disabled) form.current.requestSubmit(sendButton.current);
    return true;
  } }, { withinLayer: true });

  const blocked = imageCount === 0 ? null
    : uploads.summary.pending > 0 ? t.images.waiting : uploads.summary.failed > 0 ? t.images.resolveFailed : uploads.summary.rejected > 0 ? t.images.resolveRejected : null;
  const hasPayload = !!content.trim() || imageCount > 0;
  function takeFiles(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? []);
    if (list.length) void uploads.add(list);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (inFlight.current || discard || !hasPayload || blocked) return;
    const sourceDev = lookupDevice(devices, from);
    if (!sourceDev) { setError(new Error(t.sourceMustBeRegistered)); return; }
    const isAnyTarget = to.trim().toLowerCase() === ANY_DEVICE_ID || isReservedDeviceName(to) || to.trim() === t.devices[3];
    const targetDev = lookupDevice(devices, to);
    if (!targetDev && !isAnyTarget) { setError(new Error(t.targetMustBeRegistered)); return; }
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const attachmentIds = uploads.summary.attachmentIds;
    const signature = JSON.stringify([data, attachmentIds]);
    if (!attempt.current || attempt.current.signature !== signature) attempt.current = { key: crypto.randomUUID(), signature };
    const previous = document.activeElement;
    // State updates alone do not lock two submissions arriving before React renders.
    inFlight.current = true;
    setSaving(true); setError(null);
    try {
      onCreated(await api<Handoff>("/api/handoffs", "POST", { ...data, sourceDevice: deviceRef(devices, data.sourceDevice), targetDevice: deviceRef(devices, data.targetDevice),
        expiresInDays: Number(data.expiresInDays), requestKey: attempt.current.key, ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(replyTo ? { replyTo: replyTo.id } : {}) }));
    }
    catch (e) {
      failedFocus.current = previous instanceof HTMLElement ? previous : null;
      setError(e); setSaving(false); inFlight.current = false;
    }
  }
  return <dialog ref={dialog} className="compose" aria-labelledby="compose-title" data-dragging={dragging || undefined}
    onPaste={event => {
      // Only clipboard files are taken over; pasting text into the prompt keeps working normally.
      if (event.clipboardData.files.length && !saving && !discard) { event.preventDefault(); takeFiles(event.clipboardData.files); }
    }}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files") && !saving && !discard) { event.preventDefault(); setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files") && !saving && !discard) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { setDragging(false); if (event.dataTransfer.files.length && !saving && !discard) { event.preventDefault(); takeFiles(event.dataTransfer.files); } }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      containDialogFocus(event, dialog.current);
      if (event.key !== "Escape") return;
      // Own Escape before the browser's close watcher can close a dialog whose confirmation just changed.
      event.preventDefault();
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
      if (discard) continueEditing(); else requestClose();
    }}
    onCancel={event => { event.preventDefault(); if (composing.current) return; if (discard) continueEditing(); else requestClose(); }}
    onClick={event => { if (event.target === dialog.current) requestClose(); }}>
    <form ref={form} onSubmit={submit}>
      <div className="compose-head">
        <div><h2 id="compose-title">{replyTo ? t.receipts.replyTitle(replyTo.title) : t.composeTitle}</h2><p>{replyTo ? t.receipts.replySub : t.composeSub}</p></div>
        <button type="button" className="icon" aria-label={t.close} disabled={saving || discard} onClick={requestClose}><X size={18} /></button>
      </div>
      {!isCurrentRegistered && <div className="banner warn" role="alert" style={{ margin: "14px 0" }}>
        <TriangleAlert size={16} />
        <span>{t.deviceNotRegisteredWarn}</span>
        {onChooseDevice && <button type="button" className="link" onClick={onChooseDevice}>{t.goToRegisterDevice}</button>}
      </div>}
      <fieldset className="compose-fields" disabled={saving || discard} inert={discard}>
      <label className="field">{t.fieldTitle}<input name="title" required maxLength={HANDOFF_LIMITS.titleCharacters} autoFocus placeholder={t.fieldTitlePh}
        defaultValue={replyTo ? replyTitle(replyTo.title) : undefined} /></label>
      <div className="field-row">
        <DeviceCombobox name="sourceDevice" label={t.fieldFrom} value={from} onChange={setFrom} devices={devices} suggestions={sourceSuggestions} disabled={saving || discard} required maxLength={80} />
        <ArrowRight size={16} className="field-arrow" aria-hidden="true" />
        <DeviceCombobox name="targetDevice" label={t.fieldTo} value={to} onChange={setTo} devices={devices} suggestions={targetSuggestions} disabled={saving || discard} required maxLength={80} />
      </div>
      <ProjectCombobox name="project" label={t.fieldProject} value={project} onChange={setProject} projects={projects} disabled={saving || discard} />
      <label className="field">{t.fieldPrompt}<textarea name="content" required={imageCount === 0} maxLength={200000} value={content} onChange={e => setContent(e.target.value)} placeholder={t.fieldPromptPh} spellCheck={false} /></label>
      <AttachmentTray images={uploads.images} dragging={dragging} disabled={saving || discard} onAdd={takeFiles} onRemove={uploads.remove} onRetry={uploads.retry} onMove={uploads.move} />
      <div className="compose-meta">
        <span className="tnum">{t.charCount(content.length)}</span>
        <label>{t.expiresIn}<select name="expiresInDays" defaultValue="30">{[7, 30, 90, 365].map(d => <option key={d} value={d}>{t.days(d)}</option>)}</select></label>
      </div>
      {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
      {!error && blocked && <p role="status" className="attach-block">{blocked}</p>}
      <div className="compose-foot">
        <span><LockKeyhole size={13} aria-hidden="true" />{t.composeFoot}</span>
        <button ref={sendButton} type="submit" className="btn primary" aria-keyshortcuts={SHORTCUTS.send.aria} disabled={saving || !hasPayload || !!blocked || !isCurrentRegistered}>{saving ? t.sending : t.send}<ShortcutHint action="send" /><ArrowRight size={16} /></button>
      </div>
      </fieldset>
      {discard && <section className="discard-confirm" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-body">
        <h3 id="discard-title">{t.discardTitle}</h3><p id="discard-body">{t.discardBody}</p>
        <div><button ref={continueButton} type="button" className="btn" onClick={continueEditing}>{t.continueEditing}</button>
          <button type="button" className="btn danger" onClick={onClose}>{t.discardChanges}</button></div>
      </section>}
    </form>
  </dialog>;
}
