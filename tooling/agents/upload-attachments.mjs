// Local image uploader for agents that send handoffs with images. It reads files from this device, uploads each to the
// Site's Agent Token endpoint and returns the ordered attachment IDs for `create_handoff`.
// Credentials come from the environment only and are never printed, logged or put in an error message.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_LIMITS, inspectImage } from "../../src/shared/images/inspect-image.mjs";

export const UPLOAD_SUFFIX = "/api/agent/attachments";
const TOKEN_PATTERN = /^agentrelay_[a-f0-9]{64}$/i;
const UPLOAD_TIMEOUT_MS = 60_000;

export class UploadError extends Error {}

/** The Authorization value for the Sites gateway: Codex stores the whole header value, other agents only the token. */
export function gatewayAuthorization(env = process.env) {
  const header = env.AGENTRELAY_SITES_GATEWAY_HEADER?.trim();
  if (header) return header;
  const token = env.AGENTRELAY_SITES_GATEWAY_TOKEN?.trim();
  if (token) return `Bearer ${token}`;
  throw new UploadError("Set AGENTRELAY_SITES_GATEWAY_TOKEN (or, for Codex, AGENTRELAY_SITES_GATEWAY_HEADER) in this terminal. It is read from the environment and never written to a file.");
}

export function agentTokenFrom(env = process.env) {
  const token = env.AGENTRELAY_AGENT_TOKEN?.trim() ?? "";
  if (!token) throw new UploadError("Set AGENTRELAY_AGENT_TOKEN in this terminal. It is read from the environment and never written to a file.");
  if (!TOKEN_PATTERN.test(token)) throw new UploadError("Use a newly issued agentrelay_ personal Agent Token; retired credentials are not supported.");
  return token;
}

/** Check every file before uploading any, so one bad image never leaves the others half-uploaded. */
export async function prepareFiles(files, { read = readFile } = {}) {
  if (!files.length) throw new UploadError("Give at least one image file path.");
  if (files.length > IMAGE_LIMITS.maxImages) throw new UploadError(`A handoff holds at most ${IMAGE_LIMITS.maxImages} images; ${files.length} were given.`);
  const prepared = [];
  for (const file of files) {
    let bytes;
    try { bytes = new Uint8Array(await read(file)); } catch (error) { throw new UploadError(`Cannot read ${file} (${error?.code ?? "read error"}).`); }
    const inspected = inspectImage(bytes);
    if (!inspected.ok) throw new UploadError(`${path.basename(file)}: ${inspected.detail}`);
    prepared.push({ file, name: path.basename(file), bytes, mimeType: inspected.mimeType });
  }
  return prepared;
}

/**
 * Upload the files in order, one request each. Returns the attachment metadata in the same order.
 * The retry key makes a repeated run of the same command return the same uploads instead of new ones.
 */
export async function uploadImages({ files, siteUrl, agentToken, authorization, retryKey, fetchImpl = fetch, read }) {
  const prepared = await prepareFiles(files, { read });
  const results = [];
  for (const [index, item] of prepared.entries()) {
    let response;
    try {
      response = await fetchImpl(`${siteUrl}${UPLOAD_SUFFIX}`, {
        method: "POST",
        headers: { "Content-Type": item.mimeType, "X-Filename": encodeURIComponent(item.name), "X-Upload-Key": `${retryKey}-${index}`,
          Authorization: `Bearer ${agentToken}`, "OAI-Sites-Authorization": authorization },
        body: item.bytes, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS), redirect: "error",
      });
    } catch (error) {
      throw new UploadError(`${item.name}: cannot reach the AgentRelay site (${error?.cause?.code ?? error?.name ?? "network error"}).`);
    }
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* A restricted site answers a wrong gateway token with an HTML page. */ }
    if (response.status === 401 || response.status === 403)
      throw new UploadError(`${item.name}: AgentRelay refused the credentials (${response.status}). Check AGENTRELAY_AGENT_TOKEN and the Sites gateway token for this Site.`);
    if (!response.ok || !body?.id) {
      const reason = typeof body?.error === "string" ? body.error : `answered ${response.status} without upload data; check the endpoint URL and the Sites gateway token`;
      throw new UploadError(`${item.name}: ${reason}`);
    }
    results.push(body);
  }
  return results;
}
