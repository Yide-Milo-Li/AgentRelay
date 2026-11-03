// Local image downloader for agents whose client does not hand them an MCP image block (or saves it to a file they
// cannot open). It reads the handoff's image manifest, fetches each original through the Site's Agent Token route,
// verifies size and SHA-256 against the manifest and writes the files into one folder.
// Credentials come from the environment only and are never printed, logged or put in an error message.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMAGE_EXTENSION, IMAGE_LIMITS, sha256Hex } from "../../src/shared/images/inspect-image.mjs";
import { agentHeaders } from "./upload-attachments.mjs";

const TIMEOUT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class DownloadError extends Error {}

/** `<tmp>/agentrelay/<handoffId>`: outside any repository, and stable so a rerun finds its earlier files. */
export const defaultOutputDir = (handoffId, base = tmpdir()) => path.join(base, "agentrelay", handoffId);

/**
 * A local file name for one image. The stored filename is untrusted text, so only its safe characters are kept, the
 * extension follows the manifest's image type, and the position prefix keeps names unique and in manifest order.
 */
export function localFileName(position, filename, mimeType) {
  const extension = IMAGE_EXTENSION[mimeType];
  if (!extension) throw new DownloadError(`Unsupported image type in the manifest: ${String(mimeType).slice(0, 40)}.`);
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "image";
  return `${String(position).padStart(2, "0")}-${stem}.${extension}`;
}

async function send(fetchImpl, url, init, label) {
  try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" }); }
  catch (error) { throw new DownloadError(`${label}: cannot reach the AgentRelay site (${error?.cause?.code ?? error?.name ?? "network error"}).`); }
}

function refusal(response, label) {
  if (response.status === 401 || response.status === 403)
    return new DownloadError(`${label}: AgentRelay refused the credentials (${response.status}). Check AGENTRELAY_AGENT_TOKEN and, on ChatGPT Sites, the gateway token for this Site.`);
  if (response.status === 404) return new DownloadError(`${label}: not found. The handoff or image does not exist in this workspace, or the handoff has expired.`);
  return null;
}

/** The ordered image manifest of one handoff, read through the same MCP tool an agent already uses. */
export async function readManifest({ handoffId, siteUrl, agentToken, authorization, fetchImpl = fetch }) {
  const response = await send(fetchImpl, `${siteUrl}/api/agent/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...agentHeaders(agentToken, authorization) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_handoff", arguments: { id: handoffId } } }),
  }, "manifest");
  const text = await response.text();
  const refused = refusal(response, "manifest");
  if (refused) throw refused;
  let result = null;
  try { result = JSON.parse(text)?.result; } catch { /* A restricted site answers a wrong gateway token with an HTML page. */ }
  const payload = result?.content?.[0]?.text;
  if (!response.ok || !result || typeof payload !== "string") throw new DownloadError(`manifest: answered ${response.status} without handoff data; check the endpoint URL and, on ChatGPT Sites, the gateway token.`);
  if (result.isError) throw new DownloadError(`manifest: ${payload.slice(0, 200)}`);
  let handoff;
  try { handoff = JSON.parse(payload); } catch { throw new DownloadError("manifest: the handoff answer was not understood."); }
  const attachments = Array.isArray(handoff?.attachments) ? [...handoff.attachments].sort((a, b) => a.position - b.position) : [];
  if (!attachments.length) throw new DownloadError("This handoff has no images.");
  if (attachments.length > IMAGE_LIMITS.maxImages) throw new DownloadError("manifest: more images than a handoff can hold.");
  for (const info of attachments) {
    if (!SAFE_ID.test(String(info.id)) || !/^[a-f0-9]{64}$/.test(String(info.sha256)) || !Number.isInteger(info.bytes) || info.bytes < 1 || info.bytes > IMAGE_LIMITS.maxBytes)
      throw new DownloadError("manifest: an image entry is malformed.");
  }
  return attachments;
}

async function hashOf(file) {
  try { return await sha256Hex(new Uint8Array(await readFile(file))); } catch { return null; }
}

/**
 * Download every image of a handoff, in manifest order, into `outDir`. A file that already holds the right bytes is
 * kept as it is; a new file is verified under a temporary name first, so a failure never leaves a wrong image behind.
 */
export async function downloadImages({ handoffId, siteUrl, agentToken, authorization, outDir, fetchImpl = fetch }) {
  if (!SAFE_ID.test(String(handoffId))) throw new DownloadError("Give a handoff id exactly as listed by list_handoffs.");
  const dir = path.resolve(outDir ?? defaultOutputDir(handoffId));
  const manifest = await readManifest({ handoffId, siteUrl, agentToken, authorization, fetchImpl });
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const [index, info] of manifest.entries()) {
    const name = localFileName(index + 1, info.filename, info.mimeType), target = path.resolve(dir, name);
    if (path.dirname(target) !== dir) throw new DownloadError(`${name}: refused to write outside the output folder.`);
    const entry = { attachmentId: info.id, position: index + 1, path: target, mimeType: info.mimeType, bytes: info.bytes, sha256: info.sha256 };
    if (await hashOf(target) === info.sha256) { files.push(entry); continue; }
    const response = await send(fetchImpl, `${siteUrl}/api/agent/handoffs/${encodeURIComponent(handoffId)}/attachments/${encodeURIComponent(info.id)}`, {
      headers: agentHeaders(agentToken, authorization),
    }, name);
    const refused = refusal(response, name);
    if (refused) throw refused;
    if (!response.ok) throw new DownloadError(`${name}: the site answered ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== info.bytes) throw new DownloadError(`${name}: received ${bytes.length} bytes, the manifest says ${info.bytes}.`);
    if (await sha256Hex(bytes) !== info.sha256) throw new DownloadError(`${name}: the image failed its integrity check (SHA-256 differs from the manifest).`);
    const partial = `${target}.${crypto.randomUUID().slice(0, 8)}.part`;
    try { await writeFile(partial, bytes); await rename(partial, target); }
    catch (error) { await rm(partial, { force: true }); throw new DownloadError(`${name}: cannot write the file (${error?.code ?? "write error"}).`); }
    files.push(entry);
  }
  return { handoffId, dir, files };
}
