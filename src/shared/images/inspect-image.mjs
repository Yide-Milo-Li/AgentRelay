// Plain JavaScript on purpose: the Worker, the browser and the Node uploader share this one definition.
// It validates structure (signature, chunk/segment walk, dimensions, animation flags); it does not decode pixels.

export const IMAGE_LIMITS = Object.freeze({
  maxImages: 10,
  maxBytes: 1_048_576,
  maxEdge: 2_560,
  maxPixels: 4_000_000,
});
export const IMAGE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const IMAGE_EXTENSION = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });

/** @typedef {"unsupported" | "animated" | "corrupt" | "too_large_bytes" | "too_wide" | "too_many_pixels" | "empty"} ImageRejection */
/** @typedef {{ ok: true, mimeType: "image/png" | "image/jpeg" | "image/webp", width: number, height: number }} ImageOk */
/** @typedef {{ bytes?: number, width?: number, height?: number, edge?: number, pixels?: number }} ImageValues */
/** @typedef {{ ok: false, reason: ImageRejection, detail: string, values: ImageValues }} ImageRejected */

const formatNumber = (value) => value.toLocaleString("en-US");
/** `values` carries the numbers behind a limit message so each language can phrase it itself. */
const reject = (reason, detail, values = {}) => /** @type {ImageRejected} */ ({ ok: false, reason, detail, values });
const corrupt = (detail) => reject("corrupt", detail);

let crcTable;
function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function inspectPng(b) {
  if (b.length < 8 + 25 + 12) return corrupt("The PNG file is truncated.");
  let offset = 8, width = 0, height = 0, first = true, idat = false, animated = false;
  while (offset < b.length) {
    if (offset + 12 > b.length) return corrupt("The PNG file is truncated.");
    const length = u32be(b, offset), type = ascii(b, offset + 4, 4), end = offset + 12 + length;
    if (end > b.length) return corrupt("The PNG file is truncated.");
    if (u32be(b, end - 4) !== crc32(b, offset + 4, end - 4)) return corrupt(`The PNG ${type} chunk fails its checksum.`);
    if (first) {
      if (type !== "IHDR" || length !== 13) return corrupt("The PNG file does not start with a valid header chunk.");
      width = u32be(b, offset + 8); height = u32be(b, offset + 12); first = false;
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return corrupt("The PNG header declares an invalid size.");
    } else if (type === "IHDR") return corrupt("The PNG file has a second header chunk.");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") animated = true;
    if (type === "IDAT") idat = true;
    offset = end;
    if (type === "IEND") {
      if (length !== 0) return corrupt("The PNG end chunk is not empty.");
      if (offset !== b.length) return corrupt("The PNG file has extra data after its end chunk.");
      if (!idat) return corrupt("The PNG file has no image data.");
      if (animated) return reject("animated", "Animated PNG (APNG) files are not supported; use a static image.");
      return { ok: true, mimeType: "image/png", width, height };
    }
  }
  return corrupt("The PNG file has no end chunk.");
}

function inspectJpeg(b) {
  let offset = 2, width = 0, height = 0, frame = false, scan = false;
  while (offset < b.length) {
    if (b[offset] !== 0xff) return corrupt("The JPEG file contains data where a marker was expected.");
    while (b[offset] === 0xff) offset++; // fill bytes
    const marker = b[offset++];
    if (marker === undefined) break;
    if (marker === 0xd9) {
      if (!frame || !scan) return corrupt("The JPEG file ends before any image data.");
      return { ok: true, mimeType: "image/jpeg", width, height };
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) continue;
    if (offset + 2 > b.length) return corrupt("The JPEG file is truncated.");
    const length = u16be(b, offset);
    if (length < 2 || offset + length > b.length) return corrupt("The JPEG file is truncated.");
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) return reject("unsupported", "This JPEG uses a lossless or arithmetic-coded variant that browsers cannot show.");
      if (frame) return corrupt("The JPEG file has more than one frame header.");
      if (length < 8) return corrupt("The JPEG frame header is truncated.");
      height = u16be(b, offset + 3); width = u16be(b, offset + 5); frame = true;
      if (!width || !height) return corrupt("The JPEG header declares an invalid size.");
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) return corrupt("The JPEG scan comes before its frame header.");
      scan = true;
      // Entropy-coded data: skip stuffed zeros and restart markers until the next real marker.
      while (offset < b.length - 1 && !(b[offset] === 0xff && b[offset + 1] !== 0x00 && !(b[offset + 1] >= 0xd0 && b[offset + 1] <= 0xd7))) offset++;
    }
  }
  return corrupt("The JPEG file has no end marker.");
}

function inspectWebp(b) {
  if (b.length < 20) return corrupt("The WebP file is truncated.");
  if (u32le(b, 4) + 8 !== b.length) return corrupt("The WebP size field does not match the file length.");
  let offset = 12, canvas = null, bitstream = null, animated = false, index = 0;
  while (offset < b.length) {
    if (offset + 8 > b.length) return corrupt("The WebP file is truncated.");
    const type = ascii(b, offset, 4), size = u32le(b, offset + 4), data = offset + 8, end = data + size;
    if (end > b.length) return corrupt("The WebP file is truncated.");
    if (index === 0 && !["VP8 ", "VP8L", "VP8X"].includes(type)) return corrupt("The WebP file does not start with an image chunk.");
    if (type === "VP8X") {
      if (index !== 0 || size < 10) return corrupt("The WebP extended header is invalid.");
      if (b[data] & 0x02) animated = true;
      canvas = { width: (b[data + 4] | (b[data + 5] << 8) | (b[data + 6] << 16)) + 1, height: (b[data + 7] | (b[data + 8] << 8) | (b[data + 9] << 16)) + 1 };
    } else if (type === "ANIM" || type === "ANMF") animated = true;
    else if ((type === "VP8 " || type === "VP8L") && !bitstream) {
      if (type === "VP8 ") {
        if (size < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return corrupt("The WebP lossy bitstream header is invalid.");
        bitstream = { width: (b[data + 6] | (b[data + 7] << 8)) & 0x3fff, height: (b[data + 8] | (b[data + 9] << 8)) & 0x3fff };
      } else {
        if (size < 5 || b[data] !== 0x2f) return corrupt("The WebP lossless bitstream header is invalid.");
        const bits = u32le(b, data + 1);
        bitstream = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (!bitstream.width || !bitstream.height) return corrupt("The WebP header declares an invalid size.");
    }
    offset = end + (size & 1);
    index++;
  }
  if (offset > b.length + 1) return corrupt("The WebP file is truncated.");
  if (animated) return reject("animated", "Animated WebP files are not supported; use a static image.");
  if (!bitstream) return corrupt("The WebP file has no image data.");
  const size = canvas ?? bitstream;
  if (canvas && (canvas.width !== bitstream.width || canvas.height !== bitstream.height)) return corrupt("The WebP canvas size does not match its image data.");
  return { ok: true, mimeType: "image/webp", width: size.width, height: size.height };
}

/** Identify the format from magic bytes only; the declared MIME type and extension are never trusted. */
export function sniffImageType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

/**
 * Validate one image against the v1 policy. Limits are inclusive.
 * @param {Uint8Array} bytes
 * @param {typeof IMAGE_LIMITS} [limits]
 * @returns {ImageOk | ImageRejected}
 */
export function inspectImage(bytes, limits = IMAGE_LIMITS) {
  if (!bytes.length) return reject("empty", "The file is empty.");
  if (bytes.length > limits.maxBytes) return reject("too_large_bytes", `The image is ${formatNumber(bytes.length)} bytes; the limit is ${formatNumber(limits.maxBytes)} bytes.`, { bytes: bytes.length });
  const type = sniffImageType(bytes);
  if (!type) return reject("unsupported", "Only PNG, JPEG and WebP images are supported.");
  const result = type === "image/png" ? inspectPng(bytes) : type === "image/jpeg" ? inspectJpeg(bytes) : inspectWebp(bytes);
  if (!result.ok) return result;
  const edge = Math.max(result.width, result.height);
  if (edge > limits.maxEdge) return reject("too_wide", `The image is ${result.width}×${result.height} px; its longest edge is ${formatNumber(edge)} px and the limit is ${formatNumber(limits.maxEdge)} px.`, { width: result.width, height: result.height, edge });
  const pixels = result.width * result.height;
  if (pixels > limits.maxPixels) return reject("too_many_pixels", `The image is ${result.width}×${result.height} px (${formatNumber(pixels)} pixels); the limit is ${formatNumber(limits.maxPixels)} pixels.`, { width: result.width, height: result.height, pixels });
  return result;
}

/** Hex SHA-256 through Web Crypto, available in the Worker, the browser and Node. */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
