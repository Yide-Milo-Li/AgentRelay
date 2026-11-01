import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { IMAGE_LIMITS, inspectImage } from "../../src/shared/images/inspect-image.mjs";
import { asAnimated, corrupt, flat } from "../support/image-fixtures.mjs";

const { describeError } = await loadTypeScriptModule("src/shared/i18n/describe-error.ts");
const { AgentRelayClientError } = await loadTypeScriptModule("src/shared/errors/agent-relay-client-error.ts");
const { describeImageProblem } = await loadTypeScriptModule("src/features/handoffs/attachment-text.ts");
const { dictionaries } = await loadTypeScriptModule("src/shared/i18n/messages.ts");

const server = message => new AgentRelayClientError("errFailed", message);

test("every server image message has a Chinese form that keeps its numbers", async () => {
  const cases = [
    [inspectImage(new Uint8Array(IMAGE_LIMITS.maxBytes + 7)).detail, ["1,048,583", "1,048,576"]],
    [inspectImage(await flat({ format: "png", width: 2561, height: 1 })).detail, ["2561×1", "2,561", "2,560"]],
    [inspectImage(await flat({ format: "png", width: 2000, height: 2001 })).detail, ["2000×2001", "4,002,000", "4,000,000"]],
    [inspectImage(corrupt.truncate(await flat({ format: "jpeg", width: 30, height: 30 }), 40)).detail, ["JPEG"]],
    [inspectImage(asAnimated(await flat({ format: "webp" }), "webp")).detail, ["WebP"]],
    ["The image is 1,048,577 bytes; the limit is 1,048,576 bytes.", ["1,048,577", "1,048,576"]],
    ["The image is larger than the 1,048,576-byte limit.", ["1,048,576"]],
    ["The request says image/jpeg, but the file is image/png. Send the real type or omit it.", ["image/jpeg", "image/png"]],
  ];
  for (const [english, numbers] of cases) {
    const chinese = describeError(server(english), "zh");
    assert.notEqual(chinese, english, english);
    assert.match(chinese, /[一-鿿]/, english);
    for (const number of numbers) assert.ok(chinese.includes(number), `${number} missing from: ${chinese}`);
    assert.equal(describeError(server(english), "en"), english);
  }
});

test("fixed server messages about uploads and attachments are translated", () => {
  for (const message of [
    "This upload key was already used for a different image.", "An attached image doesn't exist. Upload it again.", "An attached image already belongs to another handoff. Upload it again.",
    "The attached images changed while sending. Try again.", "attachmentIds must list at most 10 unique upload IDs.", "This image doesn't exist or has expired.",
    "This handoff has no text to export; it contains images only.", "Only PNG, JPEG and WebP images are supported.", "An upload key of 1–120 printable characters is required.",
  ]) assert.match(describeError(server(message), "zh"), /[一-鿿]/, message);
});

test("local image problems read naturally in both languages and carry the real numbers", () => {
  const errorText = error => describeError(error, "en");
  const wide = { kind: "rejection", reason: "too_wide", values: { width: 3000, height: 10, edge: 3000 } };
  const en = describeImageProblem(wide, dictionaries.en, "en-US", errorText), zh = describeImageProblem(wide, dictionaries.zh, "zh-CN", errorText);
  assert.match(en, /3000×10/); assert.match(en, /3,000/); assert.match(en, /2,560/);
  assert.match(zh, /3000×10/); assert.match(zh, /3,000/); assert.match(zh, /2,560/); assert.match(zh, /像素/);
  const big = { kind: "rejection", reason: "too_large_bytes", values: { bytes: 2_000_000 } };
  assert.match(describeImageProblem(big, dictionaries.en, "en-US", errorText), /2,000,000 bytes.*1,048,576 bytes/);
  assert.match(describeImageProblem(big, dictionaries.zh, "zh-CN", errorText), /2,000,000 字节.*1,048,576 字节/);
  assert.match(describeImageProblem({ kind: "tooMany" }, dictionaries.en, "en-US", errorText), /10 images/);
  assert.match(describeImageProblem({ kind: "tooMany" }, dictionaries.zh, "zh-CN", errorText), /10 张/);
  for (const reason of ["unsupported", "animated", "corrupt", "empty"]) {
    const problem = { kind: "rejection", reason, values: {} };
    assert.ok(describeImageProblem(problem, dictionaries.en, "en-US", errorText).length > 10);
    assert.match(describeImageProblem(problem, dictionaries.zh, "zh-CN", errorText), /[一-鿿]/);
  }
});

test("the English and Chinese image dictionaries define the same keys", () => {
  const keys = value => Object.entries(value).flatMap(([key, item]) => typeof item === "object" && item && !Array.isArray(item) ? keys(item).map(inner => `${key}.${inner}`) : [key]);
  assert.deepEqual(keys(dictionaries.en.images).sort(), keys(dictionaries.zh.images).sort());
  assert.deepEqual(keys(dictionaries.en.storage).sort(), keys(dictionaries.zh.storage).sort());
});
