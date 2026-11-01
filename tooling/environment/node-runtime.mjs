/** Reject Windows runtimes missing the libuv OSVERSIONINFOW fix before opening sockets. */
export function assertSupportedNodeRuntime({ platform = process.platform, version = process.version } = {}) {
  if (platform !== "win32") return;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  // libuv's version alone is insufficient: Node carries the fix as a cherry-pick.
  // https://github.com/libuv/libuv/pull/5107
  if (match && ((major === 24 && minor >= 20) || (major === 26 && minor >= 1) || major > 26)) return;
  throw new Error(`Unsupported Windows Node.js ${version}. Use Node.js 24.21.0 (.node-version), or 24.20+ on 24.x / 26.1+. Older builds can crash during TCP connect with 0xC0000409 (libuv#5107).`);
}
