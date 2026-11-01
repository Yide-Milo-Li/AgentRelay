import test from "node:test";
import assert from "node:assert/strict";
import { IMAGE_LIMITS, inspectImage, sha256Hex, sniffImageType } from "../../src/shared/images/inspect-image.mjs";
import { asAnimated, corrupt, flat, mimeOf, padTo } from "../support/image-fixtures.mjs";

const FORMATS = ["png", "jpeg", "webp"];
const reason = (bytes) => { const result = inspectImage(bytes); return result.ok ? "ok" : result.reason; };

for (const format of FORMATS) {
  test(`${format}: a valid static image reports its type and size`, async () => {
    const result = inspectImage(await flat({ format, width: 37, height: 21 }));
    assert.deepEqual(result, { ok: true, mimeType: mimeOf(format), width: 37, height: 21 });
  });

  test(`${format}: edge limit is inclusive at 2560 and rejected at 2561`, async () => {
    assert.equal(reason(await flat({ format, width: 2560, height: 1 })), "ok");
    assert.equal(reason(await flat({ format, width: 1, height: 2560 })), "ok");
    assert.equal(reason(await flat({ format, width: 2561, height: 1 })), "too_wide");
    assert.equal(reason(await flat({ format, width: 1, height: 2561 })), "too_wide");
  });

  test(`${format}: pixel limit is inclusive at 4,000,000 and rejected above`, async () => {
    assert.equal(reason(await flat({ format, width: 2000, height: 2000 })), "ok");
    assert.equal(reason(await flat({ format, width: 2000, height: 2001 })), "too_many_pixels");
    assert.equal(reason(await flat({ format, width: 2560, height: 1562 })), "ok");
    assert.equal(reason(await flat({ format, width: 2560, height: 1563 })), "too_many_pixels");
  });

  test(`${format}: byte limit is inclusive at 1,048,576 and rejected at +1`, async () => {
    const base = await flat({ format, width: 64, height: 64 });
    const exact = padTo(base, format, IMAGE_LIMITS.maxBytes);
    assert.equal(exact.length, IMAGE_LIMITS.maxBytes);
    assert.deepEqual(inspectImage(exact), { ok: true, mimeType: mimeOf(format), width: 64, height: 64 });
    if (format === "webp") return; // WebP padding keeps the RIFF size even; +1 is covered by the other formats.
    const over = padTo(base, format, IMAGE_LIMITS.maxBytes + 1);
    assert.equal(reason(over), "too_large_bytes");
  });

  test(`${format}: truncated and damaged files are corrupt`, async () => {
    const good = await flat({ format, width: 40, height: 40 });
    assert.equal(reason(corrupt.truncate(good, good.length - 6)), "corrupt");
    assert.equal(reason(corrupt.truncate(good, 30)), "corrupt");
  });
}

test("png: a flipped byte inside a chunk fails its checksum", async () => {
  const good = await flat({ format: "png", width: 40, height: 40 });
  const result = inspectImage(corrupt.flip(good, 20));
  assert.equal(result.ok, false);
  assert.match(result.detail, /checksum|header/);
});

test("png: extra data after the end chunk is corrupt", async () => {
  const good = await flat({ format: "png" });
  const longer = new Uint8Array(good.length + 4); longer.set(good);
  assert.equal(reason(longer), "corrupt");
});

test("animated PNG and animated WebP are rejected as animated", async () => {
  assert.equal(reason(asAnimated(await flat({ format: "png" }), "png")), "animated");
  assert.equal(reason(asAnimated(await flat({ format: "webp" }), "webp")), "animated");
});

test("unsupported formats and empty input are named explicitly", () => {
  assert.equal(reason(new Uint8Array()), "empty");
  assert.equal(reason(new TextEncoder().encode("GIF89a....")), "unsupported");
  assert.equal(reason(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), "unsupported");
});

test("the declared type is never consulted: sniffing uses bytes only", async () => {
  assert.equal(sniffImageType(await flat({ format: "jpeg" })), "image/jpeg");
  assert.equal(sniffImageType(await flat({ format: "webp" })), "image/webp");
  assert.equal(sniffImageType(new Uint8Array([1, 2, 3])), null);
});

test("limit messages state the actual value and the limit", async () => {
  const result = inspectImage(await flat({ format: "png", width: 2561, height: 1 }));
  assert.match(result.detail, /2,561/);
  assert.match(result.detail, /2,560/);
});

test("sha256Hex matches the known digest of 'abc'", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("padded near-limit fixtures still decode with a real decoder", async () => {
  const { default: sharp } = await import("sharp");
  for (const format of FORMATS) {
    const padded = padTo(await flat({ format, width: 64, height: 48 }), format, IMAGE_LIMITS.maxBytes);
    const meta = await sharp(padded).metadata();
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 48);
    assert.equal(meta.pages ?? 1, 1);
  }
});
