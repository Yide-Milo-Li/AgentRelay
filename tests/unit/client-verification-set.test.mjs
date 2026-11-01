import test from "node:test";
import assert from "node:assert/strict";
import { IMAGE_LIMITS, inspectImage } from "../../src/shared/images/inspect-image.mjs";
import { assertSetIsValid, buildVerificationSet, codePixels } from "../support/client-verification-set.mjs";

test("the real-client verification set is valid, exact at the limits and unique per run", async () => {
  const set = await buildVerificationSet();
  assertSetIsValid(set);
  const byName = Object.fromEntries(set.map(item => [item.name, item]));
  for (const format of ["png", "jpg", "webp"]) assert.equal(byName[`near-limit-${format === "jpg" ? "jpeg" : format}.${format}`].bytes.length, IMAGE_LIMITS.maxBytes);
  assert.equal(inspectImage(byName["longest-edge-png.png"].bytes).width, IMAGE_LIMITS.maxEdge);
  const pixels = inspectImage(byName["max-pixels-webp.webp"].bytes);
  assert.equal(pixels.width * pixels.height, IMAGE_LIMITS.maxPixels);
  assert.equal(set.filter(item => item.name.startsWith("ten-")).length, 10);
  assert.equal(new Set(set.map(item => item.code)).size, set.length, "every picture carries its own code");
  assert.ok(set.every(item => /^\d{6}$/.test(item.code)));
});

test("the code is drawn inside the picture at every size used", () => {
  for (const [width, height] of [[480, 240], [2560, 300], [2000, 2000], [400, 200]]) {
    const pixel = codePixels("123456", width, height);
    let ink = 0, outsideMargin = 0;
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      if (pixel(x, y)[0] < 60) { ink++; if (x < width * 0.04 || x > width * 0.96) outsideMargin++; }
    }
    assert.ok(ink > 100, `${width}x${height} shows ink`);
    assert.equal(outsideMargin, 0, `${width}x${height} keeps the digits inside the frame`);
  }
});
