let boot;
let intentionalErrors = 0;
const calls = new Map();

const worker = {
  async fetch(request) {
    boot ??= crypto.randomUUID();
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/application-error") {
        intentionalErrors++;
        return Response.json({ error: "synthetic application failure" }, { status: 500 });
      }
      return Response.json({ boot, calls: Object.fromEntries(calls), intentionalErrors }, { status: url.pathname === "/api/storage" ? 401 : 200 });
    }
    // Read the whole transferred body, isolating idle connection reuse from early-response draining.
    const bytes = await new Request(request).arrayBuffer();
    const id = request.headers.get("x-probe-id");
    calls.set(id, (calls.get(id) ?? 0) + 1);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    return Response.json({ boot, id, sha256, bytes: bytes.byteLength }, { status: 201 });
  },
};

export default worker;
