import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const satoriRequire = createRequire(require.resolve("satori"));
const opentypeRequire = createRequire(satoriRequire.resolve("@shuding/opentype.js"));

test("the image-generation dependencies use a compatible patched ZIP parser", () => {
  for (const resolver of [satoriRequire, opentypeRequire]) {
    const fflate = resolver("fflate");
    const archive = fflate.zipSync({ "sample.txt": fflate.strToU8("synthetic image metadata") });
    assert.equal(fflate.strFromU8(fflate.unzipSync(archive)["sample.txt"]), "synthetic image metadata");

    // A malformed ZIP64 entry formerly made unzipSync loop indefinitely (GHSA-px8p-9vwx-vf98).
    const probe = `
      const assert = require("node:assert/strict");
      const fflate = require(process.argv[1]);
      const bytes = new Uint8Array(1100);
      const view = new DataView(bytes.buffer);
      const end = 64, zip64 = 128, central = 1024;
      view.setUint32(end, 0x06054b50, true);
      view.setUint16(end + 8, 0xffff, true);
      view.setUint32(end + 16, 0xffffffff, true);
      view.setUint32(end - 12, zip64, true);
      view.setUint32(zip64, 0x06064b50, true);
      view.setUint32(zip64 + 32, 1, true);
      view.setUint32(zip64 + 48, central, true);
      view.setUint32(central, 0x02014b50, true);
      view.setUint32(central + 20, 0xffffffff, true);
      assert.throws(() => fflate.unzipSync(bytes));
    `;
    const result = spawnSync(process.execPath, ["-e", probe, resolver.resolve("fflate")], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    assert.equal(result.error?.code, undefined, "malformed ZIP64 parsing must finish before the timeout");
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Satori can render text with the patched font-parser dependency", async () => {
  const { default: satori } = await import("satori");
  const font = readFileSync(path.join(path.dirname(require.resolve("@vercel/og")), "Geist-Regular.ttf"));
  const svg = await satori({ type: "div", props: { style: { fontSize: 20 }, children: "AgentRelay" } }, {
    width: 240, height: 80, fonts: [{ name: "Geist", data: font, weight: 400, style: "normal" }],
  });
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /<path\b/);
});
