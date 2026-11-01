import { AgentRelayError } from "@/server/core/agent-relay-error";
import { FILENAME_MAX, IMAGE_LIMITS, IMAGE_MIME_TYPES, UPLOAD_KEY_MAX, type UploadReason } from "@/shared/contracts/attachments";
import { IMAGE_EXTENSION } from "@/shared/images/inspect-image.mjs";

const STATUS: Record<UploadReason, number> = {
  too_large_bytes: 413, unsupported: 415, mismatch: 415, animated: 422, corrupt: 422, too_wide: 422, too_many_pixels: 422, empty: 422,
};
export const uploadFailure = (reason: UploadReason, detail: string) => new AgentRelayError(detail, STATUS[reason]);

/** Retry identities are opaque printable tokens, so they can be echoed in logs and URLs without escaping. */
export function parseUploadKey(value: string | null): string {
  const key = (value ?? "").trim();
  if (!key || key.length > UPLOAD_KEY_MAX || !/^[\x21-\x7e]+$/.test(key)) throw new AgentRelayError(`An upload key of 1–${UPLOAD_KEY_MAX} printable characters is required.`);
  return key;
}

/** The filename is display text only. It never reaches an object key and is re-encoded wherever it is sent back. */
export function cleanFilename(raw: string | null, mimeType: keyof typeof IMAGE_EXTENSION): string {
  let name = raw ?? "";
  try { name = decodeURIComponent(name); } catch { /* keep the raw text */ }
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
  const characters = Array.from(name);
  if (characters.length > FILENAME_MAX) name = characters.slice(0, FILENAME_MAX).join("");
  return name || `image.${IMAGE_EXTENSION[mimeType]}`;
}

/** A declared type may only agree with the bytes; the bytes themselves decide the format. */
export function checkDeclaredType(declared: string | null, sniffed: string) {
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === sniffed) return;
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(type))
    throw uploadFailure("mismatch", `The request says ${type}, but the file is ${sniffed}. Send the real type or omit it.`);
  throw uploadFailure("unsupported", "Only PNG, JPEG and WebP images are supported.");
}

export function parseAttachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const invalid = () => new AgentRelayError(`attachmentIds must list at most ${IMAGE_LIMITS.maxImages} unique upload IDs.`);
  if (!Array.isArray(value) || value.length > IMAGE_LIMITS.maxImages) throw invalid();
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !id || id.length > 128 || seen.has(id)) throw invalid();
    seen.add(id);
  }
  return [...seen];
}
