import { IMAGE_LIMITS, IMAGE_MIME_TYPES } from "@/shared/images/inspect-image.mjs";

export { IMAGE_LIMITS, IMAGE_MIME_TYPES };
export const UPLOAD_KEY_MAX = 120;
export const FILENAME_MAX = 120;
/** Unattached uploads older than this are reclaimed; a handoff must bind them first. */
export const UNATTACHED_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
/** Browser-safe attachment metadata; object keys and owners stay server-side. */
export type AttachmentInfo = {
  id: string;
  filename: string;
  mimeType: ImageMimeType;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  /** Zero-based position inside its handoff; null while the upload is not yet attached. */
  position: number | null;
  createdAt: number;
};
export type UploadReason = "unsupported" | "animated" | "corrupt" | "too_large_bytes" | "too_wide" | "too_many_pixels" | "empty" | "mismatch";
export type CleanupSummary = {
  /** Uploads not yet attached to a handoff. */
  unattached: { count: number; bytes: number };
  /** Objects waiting for deletion from R2; `failing` counts those that already failed at least once. */
  pendingCleanup: { count: number; bytes: number; failing: number };
};
export type CleanupResult = CleanupSummary & { reclaimedUploads: number; deletedObjects: number };
