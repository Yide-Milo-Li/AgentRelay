import { uploadAttachment } from "@/server/attachments";
import type { Actor } from "@/server/core/actor";
import { sameOrigin, rawBody, json, failure } from "@/server/http";
import { IMAGE_LIMITS } from "@/shared/contracts/attachments";

/**
 * One raw image per request, shared by the web and Agent Token endpoints. Only the way the caller is identified differs.
 * Headers: `Content-Type` (optional, must agree with the bytes), `X-Filename` (percent-encoded display name), `X-Upload-Key` (retry identity).
 */
export async function handleUpload(request: Request, resolveActor: (request: Request) => Actor | Promise<Actor>) {
  try {
    sameOrigin(request);
    const actor = await resolveActor(request);
    const limit = IMAGE_LIMITS.maxBytes;
    const bytes = await rawBody(request, limit, declared => declared
      ? `The image is ${declared.toLocaleString("en-US")} bytes; the limit is ${limit.toLocaleString("en-US")} bytes.`
      : `The image is larger than the ${limit.toLocaleString("en-US")}-byte limit.`);
    const { attachment, created } = await uploadAttachment(actor, {
      bytes, filename: request.headers.get("x-filename"), uploadKey: request.headers.get("x-upload-key"), declaredType: request.headers.get("content-type"),
    });
    return json(attachment, created ? 201 : 200);
  } catch (error) { return failure(error); }
}
