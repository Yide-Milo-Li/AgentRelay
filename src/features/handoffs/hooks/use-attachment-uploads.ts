"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IMAGE_LIMITS, type AttachmentInfo } from "@/shared/contracts/attachments";
import { inspectImage, type ImageRejection } from "@/shared/images/inspect-image.mjs";
import { uploadImage } from "@/shared/http/upload";

export type LocalImageStatus = "checking" | "queued" | "uploading" | "uploaded" | "failed" | "rejected";
/** Why an image cannot be used, with the numbers each language needs to phrase it. */
export type ImageProblem =
  | { kind: "rejection"; reason: ImageRejection; values: { bytes?: number; width?: number; height?: number; edge?: number; pixels?: number } }
  | { kind: "tooMany" } | { kind: "unreadable" } | { kind: "server"; error: unknown };
export type LocalImage = {
  id: string; file: File; name: string; bytes: number; previewUrl: string; retryKey: string;
  status: LocalImageStatus; problem?: ImageProblem; info?: AttachmentInfo; width?: number; height?: number; mimeType?: string;
};

const PARALLEL_UPLOADS = 2;
const uid = () => crypto.randomUUID();

/**
 * Local state machine for the images of one handoff being composed. Each image gets its own retry key and abort
 * controller, is validated in the browser before any bytes leave, and keeps its server identity across failed submissions.
 * The order of `images` is the order of the handoff; upload completion order never changes it.
 */
export function useAttachmentUploads(enabled: boolean) {
  const [images, setImages] = useState<LocalImage[]>([]);
  const bytesById = useRef(new Map<string, Uint8Array>());
  const controllers = useRef(new Map<string, AbortController>());
  const imagesRef = useRef<LocalImage[]>([]);
  // Declared before the effect that starts uploads, so that effect always sees the list of the render it belongs to.
  useEffect(() => { imagesRef.current = images; }, [images]);

  const patch = useCallback((id: string, change: Partial<LocalImage>) => {
    setImages(previous => previous.map(image => image.id === id ? { ...image, ...change } : image));
  }, []);

  const upload = useCallback(async (id: string) => {
    const image = imagesRef.current.find(item => item.id === id), bytes = bytesById.current.get(id);
    if (!image || !bytes || !image.mimeType || controllers.current.has(id)) return;
    const controller = new AbortController();
    controllers.current.set(id, controller);
    patch(id, { status: "uploading", problem: undefined });
    try {
      const info = await uploadImage(new Blob([bytes as BlobPart], { type: image.mimeType }), { key: image.retryKey, name: image.name, mimeType: image.mimeType, signal: controller.signal });
      patch(id, { status: "uploaded", info });
    } catch (error) {
      // A cancelled upload has been removed (or restarted) by the caller; there is nothing left to report.
      if (controller.signal.aborted) return;
      patch(id, { status: "failed", problem: { kind: "server", error } });
    } finally { if (controllers.current.get(id) === controller) controllers.current.delete(id); }
  }, [patch]);

  // Start queued images two at a time. Uploads are independent; the list order is untouched.
  useEffect(() => {
    const active = images.filter(image => image.status === "uploading").length;
    images.filter(image => image.status === "queued").slice(0, Math.max(0, PARALLEL_UPLOADS - active)).forEach(image => { void upload(image.id); });
  }, [images, upload]);

  const add = useCallback(async (files: File[]) => {
    if (!enabled || !files.length) return 0;
    const room = Math.max(0, IMAGE_LIMITS.maxImages - imagesRef.current.length);
    const created: LocalImage[] = files.map(file => ({ id: uid(), file, name: file.name || "image", bytes: file.size, previewUrl: "", retryKey: uid(), status: "checking" }));
    // Files beyond the limit are listed and refused, so nothing a user dropped disappears silently.
    const accepted = created.slice(0, room), overflow = created.slice(room);
    overflow.forEach(image => { image.status = "rejected"; image.problem = { kind: "tooMany" }; });
    setImages(previous => [...previous, ...created]);
    await Promise.all(accepted.map(async image => {
      if (image.bytes > IMAGE_LIMITS.maxBytes) { patch(image.id, { status: "rejected", problem: { kind: "rejection", reason: "too_large_bytes", values: { bytes: image.bytes } } }); return; }
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await image.file.arrayBuffer()); } catch { patch(image.id, { status: "rejected", problem: { kind: "unreadable" } }); return; }
      const result = inspectImage(bytes);
      if (!result.ok) { patch(image.id, { status: "rejected", problem: { kind: "rejection", reason: result.reason, values: result.values } }); return; }
      bytesById.current.set(image.id, bytes);
      patch(image.id, { status: "queued", width: result.width, height: result.height, mimeType: result.mimeType, previewUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: result.mimeType })) });
    }));
    return accepted.length;
  }, [enabled, patch]);

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort(); controllers.current.delete(id);
    const image = imagesRef.current.find(item => item.id === id);
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    bytesById.current.delete(id);
    setImages(previous => previous.filter(item => item.id !== id));
  }, []);

  const retry = useCallback((id: string) => { patch(id, { status: "queued", problem: undefined }); }, [patch]);
  const move = useCallback((id: string, direction: -1 | 1) => {
    setImages(previous => {
      const from = previous.findIndex(item => item.id === id), to = from + direction;
      if (from < 0 || to < 0 || to >= previous.length) return previous;
      const next = [...previous]; [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, []);
  const cancelAll = useCallback(() => { controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }, []);

  // Release object URLs and stop in-flight uploads when the composer goes away.
  useEffect(() => () => {
    controllers.current.forEach(controller => controller.abort());
    imagesRef.current.forEach(image => { if (image.previewUrl) URL.revokeObjectURL(image.previewUrl); });
  }, []);

  const summary = useMemo(() => {
    const count = (status: LocalImageStatus) => images.filter(image => image.status === status).length;
    const pending = count("checking") + count("queued") + count("uploading");
    return { total: images.length, pending, failed: count("failed"), rejected: count("rejected"), uploaded: count("uploaded"),
      ready: images.length > 0 && pending === 0 && count("failed") === 0 && count("rejected") === 0,
      attachmentIds: images.filter(image => image.info).map(image => image.info!.id),
      /** Identity of the whole set, for unsaved-change detection and for rotating the request key. */
      signature: images.map(image => `${image.file.name}:${image.bytes}:${image.file.lastModified}:${image.retryKey}`).join("|") };
  }, [images]);

  return { images, add, remove, retry, move, cancelAll, summary };
}
