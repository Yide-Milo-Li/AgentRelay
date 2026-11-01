// Test-only synthetic images. Nothing here is real user data. `sharp` is a devDependency used only to encode.
import { crc32 } from "node:zlib";
import sharp from "sharp";

const FORMATS = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
export const mimeOf = (format) => FORMATS[format];

/** A flat-colour image: tiny on disk even at the pixel limit, so boundary tests stay fast. */
export async function flat({ format = "png", width = 8, height = 8, color = { r: 200, g: 40, b: 40 } } = {}) {
  const image = sharp({ create: { width, height, channels: 3, background: color } });
  const buffer = format === "jpeg" ? await image.jpeg({ quality: 80 }).toBuffer() : format === "webp" ? await image.webp({ lossless: true }).toBuffer() : await image.png({ compressionLevel: 9 }).toBuffer();
  return new Uint8Array(buffer);
}

/** A raw RGB picture from a pixel callback; used for pixel-only content that cannot be guessed. */
export async function fromPixels({ format = "png", width, height, pixel }) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = pixel(x, y), o = (y * width + x) * 3;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  const buffer = format === "jpeg" ? await image.jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer() : format === "webp" ? await image.webp({ lossless: true }).toBuffer() : await image.png().toBuffer();
  return new Uint8Array(buffer);
}

const u32be = (value) => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
const u32le = (value) => Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const text = (value) => new TextEncoder().encode(value);

function pngChunk(type, data) {
  const body = concat(text(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}
function insertBeforeIend(png, chunk) {
  const iend = png.length - 12;
  return concat(png.subarray(0, iend), chunk, png.subarray(iend));
}
/** Pad to an exact byte length with an ancillary text chunk (PNG), comment segments (JPEG) or an EXIF chunk (WebP). */
export function padTo(bytes, format, target) {
  if (bytes.length > target) throw new Error(`Image is already ${bytes.length} bytes; cannot pad to ${target}.`);
  const extra = target - bytes.length;
  if (!extra) return bytes;
  if (format === "png") {
    if (extra < 12 + 5) throw new Error("PNG padding needs at least 17 bytes.");
    return insertBeforeIend(bytes, pngChunk("tEXt", concat(text("pad"), Uint8Array.of(0), new Uint8Array(extra - 12 - 4))));
  }
  if (format === "jpeg") {
    let remaining = extra, padded = bytes.subarray(0, 2);
    const parts = [];
    while (remaining > 0) {
      let segment = Math.min(remaining, 65_535 + 2);
      // Never leave a remainder too small to hold a segment of its own.
      if (remaining - segment > 0 && remaining - segment < 4) segment -= 4;
      if (segment < 4) throw new Error("JPEG padding needs at least 4 bytes per segment.");
      parts.push(concat(Uint8Array.of(0xff, 0xfe, ((segment - 2) >> 8) & 255, (segment - 2) & 255), new Uint8Array(segment - 4)));
      remaining -= segment;
    }
    return concat(padded, ...parts, bytes.subarray(2));
  }
  // WebP: rebuild as an extended file (VP8X + original image chunk + EXIF padding), keeping the pixels untouched.
  const { width, height, chunk } = webpParts(bytes);
  const vp8x = webpChunk("VP8X", concat(Uint8Array.of(0, 0, 0, 0), le24(width - 1), le24(height - 1)));
  const overhead = 12 + vp8x.length + chunk.length + 8;
  const padLength = target - overhead;
  if (padLength < 0 || padLength % 2) throw new Error("WebP padding needs an even number of spare bytes.");
  return riff(concat(vp8x, chunk, webpChunk("EXIF", new Uint8Array(padLength))));
}
const le24 = (value) => Uint8Array.of(value & 255, (value >> 8) & 255, (value >> 16) & 255);
function webpChunk(type, data) { return concat(text(type), u32le(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0)); }
function riff(body) { return concat(text("RIFF"), u32le(body.length + 4), text("WEBP"), body); }
function webpParts(bytes) {
  const type = String.fromCharCode(...bytes.subarray(12, 16)), size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, true);
  const chunk = bytes.subarray(12, 20 + size + (size & 1));
  if (type === "VP8L") { const bits = new DataView(bytes.buffer, bytes.byteOffset).getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, chunk }; }
  if (type === "VP8 ") return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff, chunk };
  throw new Error(`Cannot pad a ${type} WebP.`);
}

/** Make a valid static image look animated by inserting the markers a decoder would read. */
export function asAnimated(bytes, format) {
  if (format === "png") {
    const ihdrEnd = 8 + 25;
    return concat(bytes.subarray(0, ihdrEnd), pngChunk("acTL", concat(u32be(2), u32be(0))), bytes.subarray(ihdrEnd));
  }
  if (format === "webp") {
    const { width, height, chunk } = webpParts(bytes);
    const vp8x = webpChunk("VP8X", concat(Uint8Array.of(0x02, 0, 0, 0), le24(width - 1), le24(height - 1)));
    return riff(concat(vp8x, webpChunk("ANIM", new Uint8Array(6)), chunk));
  }
  throw new Error("Only PNG and WebP can be marked animated.");
}

export const corrupt = {
  truncate: (bytes, keep = Math.floor(bytes.length / 2)) => bytes.slice(0, keep),
  flip: (bytes, at = Math.floor(bytes.length / 2)) => { const copy = bytes.slice(); copy[at] ^= 0xff; return copy; },
};
