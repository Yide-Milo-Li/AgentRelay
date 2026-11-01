"use client";
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, LoaderCircle, RotateCcw, TriangleAlert, X, Check } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { IMAGE_LIMITS, IMAGE_MIME_TYPES } from "@/shared/contracts/attachments";
import { describeImageProblem } from "../attachment-text";
import { formatStorageBytes } from "../storage-formatting";
import type { LocalImage } from "../hooks/use-attachment-uploads";

type Props = {
  images: LocalImage[];
  dragging: boolean;
  disabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
};

/** Ordered previews with their upload state. Order here is the order the receiver sees. */
export default function AttachmentTray({ images, dragging, disabled, onAdd, onRemove, onRetry, onMove }: Props) {
  const { t, locale, errorText } = useLang(), s = t.images;
  const input = useRef<HTMLInputElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const size = (bytes: number) => formatStorageBytes(bytes, locale);
  const full = images.length >= IMAGE_LIMITS.maxImages;
  return <section className="attach" aria-label={s.label} data-dragging={dragging || undefined}>
    <div className="attach-head">
      <span className="field-label">{s.label}<span className="optional">{t.optional}</span></span>
      <button type="button" className="btn small" disabled={disabled || full} onClick={() => input.current?.click()}><ImagePlus size={15} aria-hidden="true" />{s.add}</button>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} multiple accept={IMAGE_MIME_TYPES.join(",")} aria-label={s.add}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) { onAdd(files); setAnnouncement(s.added(files.length)); } }} />
    </div>
    {!images.length && <p className="attach-drop">
      <strong>{dragging ? s.dropActive : s.dropTitle}</strong>
      <span>{s.dropHint(IMAGE_LIMITS.maxImages, size(IMAGE_LIMITS.maxBytes), IMAGE_LIMITS.maxEdge)}</span>
    </p>}
    {images.length > 0 && <ol className="attach-list" aria-label={s.list}>
      {images.map((image, index) => {
        const busy = image.status === "uploading" || image.status === "checking" || image.status === "queued";
        return <li key={image.id} className="attach-item" data-status={image.status}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview cannot go through the image optimizer */}
          {image.previewUrl ? <img className="attach-thumb" src={image.previewUrl} alt={s.preview(image.name)} width={image.width} height={image.height} /> : <span className="attach-thumb attach-thumb-empty" aria-hidden="true" />}
          <div className="attach-body">
            <span className="attach-name" title={image.name}>{image.name}</span>
            <span className="attach-meta tnum">{image.width && image.height ? `${s.info(image.width, image.height, size(image.bytes))}` : size(image.bytes)} · {s.position(index + 1, images.length)}</span>
            <span className="attach-status" data-status={image.status}>
              {image.status === "uploading" && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
              {image.status === "uploaded" && <Check size={13} aria-hidden="true" />}
              {(image.status === "failed" || image.status === "rejected") && <TriangleAlert size={13} aria-hidden="true" />}
              {s.status[image.status]}
            </span>
            {image.problem && <span className="attach-problem" role="alert">{describeImageProblem(image.problem, t, locale, errorText)}</span>}
          </div>
          <div className="attach-actions">
            <button type="button" className="icon small" disabled={disabled || index === 0} aria-label={s.moveEarlier(image.name)} onClick={() => { onMove(image.id, -1); setAnnouncement(s.position(index, images.length)); }}><ArrowUp size={15} aria-hidden="true" /></button>
            <button type="button" className="icon small" disabled={disabled || index === images.length - 1} aria-label={s.moveLater(image.name)} onClick={() => { onMove(image.id, 1); setAnnouncement(s.position(index + 2, images.length)); }}><ArrowDown size={15} aria-hidden="true" /></button>
            {image.status === "failed" && <button type="button" className="icon small" disabled={disabled} aria-label={s.retry(image.name)} onClick={() => onRetry(image.id)}><RotateCcw size={15} aria-hidden="true" /></button>}
            <button type="button" className="icon small" disabled={disabled && !busy} aria-label={busy && image.status === "uploading" ? s.cancel(image.name) : s.remove(image.name)}
              onClick={() => { onRemove(image.id); setAnnouncement(s.removed(image.name)); }}><X size={15} aria-hidden="true" /></button>
          </div>
        </li>;
      })}
    </ol>}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
  </section>;
}
