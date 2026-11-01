import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { formatEnv, generateVapid, vapidSubjectOf, writeEnvFile } from "../../tooling/notifications/vapid.mjs";

const bytes = value => Buffer.from(value, "base64url");
const NAMES = ["AGENTRELAY_WEB_PUSH_ENABLED", "AGENTRELAY_VAPID_PUBLIC_KEY", "AGENTRELAY_VAPID_PRIVATE_KEY", "AGENTRELAY_VAPID_SUBJECT"];
const script = ["scripts/notifications/generate-vapid.mjs"];
const run = (...args) => spawnSync(process.execPath, [...script, ...args], { cwd: projectRoot, encoding: "utf8" });
// The documented setup points TEMP inside the checkout, where a key file is correctly refused, so fall back to the home directory.
const scratch = () => {
  const inside = candidate => !path.relative(projectRoot, candidate).startsWith("..");
  return mkdtempSync(path.join(inside(os.tmpdir()) ? os.homedir() : os.tmpdir(), "vapid-"));
};

test("a generated pair is a matching P-256 key pair in the shape the sender expects", async () => {
  const values = await generateVapid("https://example.com");
  assert.deepEqual(Object.keys(values), NAMES); assert.equal(values.AGENTRELAY_WEB_PUSH_ENABLED, "1");
  const publicKey = bytes(values.AGENTRELAY_VAPID_PUBLIC_KEY), privateKey = bytes(values.AGENTRELAY_VAPID_PRIVATE_KEY);
  assert.equal(publicKey.length, 65); assert.equal(publicKey[0], 4); assert.equal(privateKey.length, 32);
  assert.ok(!/[+/=]/.test(values.AGENTRELAY_VAPID_PUBLIC_KEY + values.AGENTRELAY_VAPID_PRIVATE_KEY), "unpadded base64url");
  // Sign with the private scalar and verify with the public point: the two halves belong together.
  const jwk = { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url"), d: values.AGENTRELAY_VAPID_PRIVATE_KEY };
  const signing = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const verifying = await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const data = new TextEncoder().encode("synthetic");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifying, await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing, data), data));
});

test("every generation is a new pair", async () => {
  const [a, b] = await Promise.all([generateVapid("https://example.com"), generateVapid("https://example.com")]);
  assert.notEqual(a.AGENTRELAY_VAPID_PRIVATE_KEY, b.AGENTRELAY_VAPID_PRIVATE_KEY);
  assert.notEqual(a.AGENTRELAY_VAPID_PUBLIC_KEY, b.AGENTRELAY_VAPID_PUBLIC_KEY);
});

test("the contact address must be an https address or a mailto address, and nothing else", () => {
  for (const ok of ["https://example.com", "https://my-site.example.chatgpt.site/", "mailto:ops@example.com"]) assert.equal(vapidSubjectOf(ok), ok);
  for (const bad of ["", "   ", "http://example.com", "javascript:alert(1)", "ftp://example.com", "https://user:secret@example.com", "https://", "mailto:", "mailto:not-an-address", "example.com", "https://exa mple.com", undefined, 5])
    assert.throws(() => vapidSubjectOf(bad), /subject/i, String(bad));
});

test("values are written one NAME=value line each, with no quoting", async () => {
  const text = formatEnv(await generateVapid("https://example.com"));
  const lines = text.trimEnd().split("\n");
  assert.deepEqual(lines.map(line => line.split("=")[0]), NAMES); assert.ok(text.endsWith("\n")); assert.ok(!/["' ]/.test(text.replace("\n", "")));
});

test("a key file is created once, outside the repository, readable only by its owner", async () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "vapid.env"), values = await generateVapid("https://example.com");
    writeEnvFile(file, values);
    assert.equal(readFileSync(file, "utf8"), formatEnv(values));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeEnvFile(file, values), /exists|already/i);
    assert.equal(readFileSync(file, "utf8"), formatEnv(values), "an existing file is never overwritten");
    for (const inside of [path.join(projectRoot, "vapid.env"), path.join(projectRoot, ".local", "vapid.env"), path.join(projectRoot, "outputs", "x", "..", "vapid.env")])
      assert.throws(() => writeEnvFile(inside, values), /repository/i, inside);
    assert.ok(!existsSync(path.join(projectRoot, "vapid.env")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the command refuses to run without a valid contact address, and says how", () => {
  for (const args of [[], ["--subject"], ["--subject", "http://example.com"], ["--subject", "mailto:nope"], ["--bogus", "x", "--subject", "https://example.com"]]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(" ")); assert.equal(result.stdout, ""); assert.match(result.stderr, /usage|subject/i);
  }
});

test("the command prints all four values when asked for no file, and never writes one", async () => {
  const result = run("--subject", "https://example.com");
  assert.equal(result.status, 0, result.stderr);
  const printed = Object.fromEntries(result.stdout.trimEnd().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(Object.keys(printed), NAMES); assert.equal(bytes(printed.AGENTRELAY_VAPID_PUBLIC_KEY).length, 65);
  assert.match(result.stderr, /private/i);
});

test("with --out the private key goes to the file only, and a path inside the repository is refused", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "vapid.env"), result = run("--subject", "mailto:ops@example.com", "--out", file);
    assert.equal(result.status, 0, result.stderr);
    const saved = Object.fromEntries(readFileSync(file, "utf8").trimEnd().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(Object.keys(saved), NAMES);
    assert.ok(result.stdout.includes(saved.AGENTRELAY_VAPID_PUBLIC_KEY)); assert.ok(!(result.stdout + result.stderr).includes(saved.AGENTRELAY_VAPID_PRIVATE_KEY));
    const again = run("--subject", "https://example.com", "--out", file);
    assert.equal(again.status, 1); assert.equal(again.stdout, "");
    const inside = run("--subject", "https://example.com", "--out", path.join(projectRoot, "vapid.env"));
    assert.equal(inside.status, 1); assert.match(inside.stderr, /repository/i); assert.ok(!existsSync(path.join(projectRoot, "vapid.env")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
