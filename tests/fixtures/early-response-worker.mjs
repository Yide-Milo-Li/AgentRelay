// Distinguish local proxy failures from business logic or an actual Worker restart.
let boot;
const worker = {
  fetch(request) {
    boot ??= crypto.randomUUID();
    // Framework adapters transfer a Request before the route decides whether to read its body.
    request = new Request(request);
    const headers = { "Content-Type": "application/json", "X-Preview-Boot": boot };
    const status = request.method === "GET" || !request.headers.has("oai-authenticated-user-id") ? 401
      : Number(request.headers.get("content-length")) > 1_300_000 ? 413 : 400;
    return new Response(JSON.stringify({ status }), { status, headers });
  },
};
export default worker;
