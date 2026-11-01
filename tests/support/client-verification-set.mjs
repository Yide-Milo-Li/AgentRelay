// Synthetic images for the real-client compatibility run. Every image shows a random six-digit code drawn as seven-segment
// digits, so a receiving agent can only answer correctly by actually looking at the pixels. The codes are written to
// answers.json, which is for the person running the verification and is never sent to a client.
//
//   node tests/support/client-verification-set.mjs [output-directory]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomInt, createHash } from "node:crypto";
import sharp from "sharp";
import { padTo } from "./image-fixtures.mjs";
import { IMAGE_LIMITS, inspectImage } from "../../src/shared/images/inspect-image.mjs";

// Segments a-g of a seven-segment digit: top, top-right, bottom-right, bottom, bottom-left, top-left, middle.
const SEGMENTS = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
// Thick strokes (22 % of the digit) keep look-alikes such as 3/2 and 9/5 apart even when a client shows the picture small.
const T = 0.22;
const RECTS = { a: [0, 0, 1, T], b: [1 - T, 0.04, T, 0.46], c: [1 - T, 0.5, T, 0.46], d: [0, 1 - T, 1, T], e: [0, 0.5, T, 0.46], f: [0, 0.04, T, 0.46], g: [0, 0.5 - T / 2, 1, T] };

/** A callback giving the RGB of each pixel for `code` drawn in the middle of a width × height picture. */
export function codePixels(code, width, height, { background = [245, 245, 235], ink = [20, 20, 40], accent = [200, 60, 30] } = {}) {
  const digits = [...code], gap = 0.4;
  const digitHeight = Math.min(height * 0.6, (width * 0.9) / (digits.length + (digits.length - 1) * gap) / 0.6);
  const digitWidth = digitHeight * 0.6, total = digits.length * digitWidth + (digits.length - 1) * digitWidth * gap;
  const left = (width - total) / 2, top = (height - digitHeight) / 2;
  const boxes = [];
  digits.forEach((digit, index) => {
    const x0 = left + index * digitWidth * (1 + gap);
    for (const segment of SEGMENTS[digit]) {
      const [rx, ry, rw, rh] = RECTS[segment];
      boxes.push([x0 + rx * digitWidth, top + ry * digitHeight, x0 + (rx + rw) * digitWidth, top + (ry + rh) * digitHeight]);
    }
  });
  return (x, y) => {
    for (const [x0, y0, x1, y1] of boxes) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return ink;
    // A thin accent frame makes the picture recognisable even when the digits are small.
    return x < 3 || y < 3 || x >= width - 3 || y >= height - 3 ? accent : background;
  };
}

function raw(width, height, pixel, noise = 0) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = pixel(x, y), o = (y * width + x) * 3, n = noise ? randomInt(-noise, noise + 1) : 0;
    data[o] = Math.max(0, Math.min(255, r + n)); data[o + 1] = Math.max(0, Math.min(255, g + n)); data[o + 2] = Math.max(0, Math.min(255, b + n));
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}
async function encode(image, format) {
  const buffer = format === "jpeg" ? await image.jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer() : format === "webp" ? await image.webp({ lossless: true, effort: 1 }).toBuffer() : await image.png({ compressionLevel: 6 }).toBuffer();
  return new Uint8Array(buffer);
}
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** A picture whose encoded size lands just under the limit, then padded to exactly the limit with an inert metadata chunk. */
async function nearLimit(format, code) {
  const background = (x, y) => [245 - (x * 7 + y * 3) % 40, 245 - (x * 5 + y * 11) % 40, 235];
  const frame = codePixels(code, 1, 1);
  void frame;
  for (let side = 760; side >= 200; side -= 20) {
    const code_ = codePixels(code, side, side);
    const bytes = await encode(raw(side, side, (x, y) => { const pixel = code_(x, y); return pixel[0] === 245 ? background(x, y) : pixel; }, format === "png" ? 255 : 60), format);
    if (bytes.length <= IMAGE_LIMITS.maxBytes - 64) return padTo(bytes, format, IMAGE_LIMITS.maxBytes);
  }
  throw new Error(`Could not build a near-limit ${format}`);
}

/** Build every verification image in memory: `{ name, bytes, code, purpose }`. */
export async function buildVerificationSet() {
  const set = [];
  const add = (name, bytes, code, purpose) => set.push({ name, bytes, code, purpose });
  for (const [format, extension] of [["png", "png"], ["jpeg", "jpg"], ["webp", "webp"]]) {
    let code = newCode();
    add(`basic-${format}.${extension}`, await encode(raw(640, 240, codePixels(code, 640, 240)), format), code, `ordinary ${format}`);
    code = newCode();
    add(`near-limit-${format}.${extension}`, await nearLimit(format, code), code, `exactly ${IMAGE_LIMITS.maxBytes} bytes (${format})`);
    code = newCode();
    add(`longest-edge-${format}.${extension}`, await encode(raw(IMAGE_LIMITS.maxEdge, 300, codePixels(code, IMAGE_LIMITS.maxEdge, 300)), format), code, `${IMAGE_LIMITS.maxEdge} px longest edge (${format})`);
    code = newCode();
    add(`max-pixels-${format}.${extension}`, await encode(raw(2000, 2000, codePixels(code, 2000, 2000)), format), code, `4,000,000 pixels (${format})`);
  }
  // A ten-image handoff: each picture carries its own number and code so order and content can both be checked.
  for (let i = 1; i <= 10; i++) {
    const code = newCode(), format = ["png", "jpeg", "webp"][i % 3], extension = format === "jpeg" ? "jpg" : format;
    add(`ten-${String(i).padStart(2, "0")}.${extension}`, await encode(raw(640, 240, codePixels(code, 640, 240, { accent: [30 + i * 20, 80, 220 - i * 15] })), format), code, `image ${i} of 10`);
  }
  return set;
}

/** Fail loudly if a generated image would not pass the product's own rules (or the near-limit ones are not exact). */
export function assertSetIsValid(set) {
  for (const item of set) {
    const result = inspectImage(item.bytes);
    if (!result.ok) throw new Error(`${item.name} is not acceptable: ${result.detail}`);
    if (item.name.startsWith("near-limit") && item.bytes.length !== IMAGE_LIMITS.maxBytes) throw new Error(`${item.name} is ${item.bytes.length} bytes`);
  }
}

async function main() {
  const out = path.resolve(process.argv[2] ?? path.join("outputs", "client-verification", new Date().toISOString().replace(/[:.]/g, "-")));
  await mkdir(out, { recursive: true });
  const set = await buildVerificationSet();
  assertSetIsValid(set);
  for (const item of set) await writeFile(path.join(out, item.name), item.bytes);
  const answers = Object.fromEntries(set.map(item => [item.name, { code: item.code, bytes: item.bytes.length, sha256: createHash("sha256").update(item.bytes).digest("hex"), purpose: item.purpose }]));
  await writeFile(path.join(out, "answers.json"), JSON.stringify(answers, null, 2));
  console.log(`Wrote ${set.length} images and answers.json to ${out}\nKeep answers.json away from the clients under test.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
