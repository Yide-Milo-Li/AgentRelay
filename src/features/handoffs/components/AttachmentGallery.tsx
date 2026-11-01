"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { AttachmentInfo } from "@/shared/contracts/attachments";
import { containDialogFocus } from "@/shared/browser/keyboard-shortcuts";
import { formatStorageBytes } from "../storage-formatting";

type Props = { attachments: AttachmentInfo[]; /** Route prefix that ends with `/attachments`. */ basePath: string };

/** Lazy thumbnails of a handoff's images with an enlargeable viewer. Images are fetched only when they scroll into view. */
export default function AttachmentGallery({ attachments, basePath }: Props) {
  const { t, locale } = useLang(), s = t.images;
  const [open, setOpen] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const opener = useRef<HTMLElement | null>(null);
  const url = (item: AttachmentInfo, download = false) => `${basePath}/${encodeURIComponent(item.id)}${download ? "?download=1" : ""}`;
  const size = (bytes: number) => formatStorageBytes(bytes, locale);
  if (!attachments.length) return null;
  return <section className="gallery" aria-label={s.gallery}>
    <h2 className="gallery-title">{s.gallery}<span className="tnum">{s.count(attachments.length)}</span></h2>
    <ul className="gallery-grid">
      {attachments.map((item, index) => <li key={item.id}>
        <button type="button" className="gallery-item" aria-label={s.open(item.filename, index + 1, attachments.length)}
          onClick={event => { opener.current = event.currentTarget; setOpen(index); }}>
          {failed.has(item.id)
            ? <span className="gallery-fail"><ImageOff size={18} aria-hidden="true" />{s.loadFailed}</span>
            // eslint-disable-next-line @next/next/no-img-element -- private, no-store responses cannot use the image optimizer
            : <img src={url(item)} alt="" loading="lazy" decoding="async" width={item.width} height={item.height} style={{ aspectRatio: `${item.width} / ${item.height}` }}
                onError={() => setFailed(previous => new Set(previous).add(item.id))} />}
          <span className="gallery-caption"><span>{item.filename}</span><span className="tnum">{s.info(item.width, item.height, size(item.bytes))}</span></span>
        </button>
      </li>)}
    </ul>
    {open !== null && <Lightbox attachments={attachments} index={open} url={url} size={size} onIndex={setOpen}
      onClose={() => { setOpen(null); const target = opener.current; if (target?.isConnected) requestAnimationFrame(() => target.focus()); }} />}
  </section>;
}

function Lightbox({ attachments, index, url, size, onIndex, onClose }: { attachments: AttachmentInfo[]; index: number; url: (item: AttachmentInfo, download?: boolean) => string;
  size: (bytes: number) => string; onIndex: (index: number) => void; onClose: () => void }) {
  const { t } = useLang(), s = t.images;
  const dialog = useRef<HTMLDialogElement>(null);
  const item = attachments[index], many = attachments.length > 1;
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => element?.close();
  }, []);
  function step(direction: -1 | 1) { const next = index + direction; if (next >= 0 && next < attachments.length) onIndex(next); }
  return <dialog ref={dialog} className="lightbox" aria-label={item.filename}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={event => {
      containDialogFocus(event, dialog.current);
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    }}>
    <header className="lightbox-bar">
      <div className="lightbox-title"><strong>{item.filename}</strong><span className="tnum">{s.counter(index + 1, attachments.length)} · {s.info(item.width, item.height, size(item.bytes))}</span></div>
      <a className="icon" href={url(item, true)} download={item.filename} aria-label={s.download(item.filename)} title={s.download(item.filename)}><Download size={18} aria-hidden="true" /></a>
      <button type="button" className="icon" data-initial-focus aria-label={s.close} title={s.close} onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="lightbox-stage">
      {many && <button type="button" className="icon lightbox-nav" disabled={index === 0} aria-label={s.previous} onClick={() => step(-1)}><ChevronLeft size={22} aria-hidden="true" /></button>}
      <LightboxImage key={item.id} item={item} src={url(item)} />
      {many && <button type="button" className="icon lightbox-nav" disabled={index === attachments.length - 1} aria-label={s.next} onClick={() => step(1)}><ChevronRight size={22} aria-hidden="true" /></button>}
    </div>
  </dialog>;
}

/** Keyed by attachment, so moving to another image starts from a clean load state. */
function LightboxImage({ item, src }: { item: AttachmentInfo; src: string }) {
  const { t } = useLang(), [broken, setBroken] = useState(false);
  if (broken) return <p className="gallery-fail" role="alert"><ImageOff size={20} aria-hidden="true" />{t.images.loadFailed}</p>;
  // eslint-disable-next-line @next/next/no-img-element -- private, no-store responses cannot use the image optimizer
  return <img src={src} alt={item.filename} width={item.width} height={item.height} onError={() => setBroken(true)} />;
}
