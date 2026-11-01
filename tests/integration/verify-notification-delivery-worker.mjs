// Exercise the real sender and fetch implementation inside workerd; Node's Request accepts unsupported redirect modes.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const source = `
import { deliverNotification } from './src/server/handoffs/notification-delivery.ts';
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export default { async fetch(request) {
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const receiver = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const privateKey = await crypto.subtle.exportKey('jwk',pair.privateKey);
  const vapid = {publicKey:encode(await crypto.subtle.exportKey('raw',pair.publicKey)),privateKey:privateKey.d,subject:'https://example.com'};
  const path = new URL(request.url).pathname;
  const destination = {endpoint: path.startsWith('/wns') ? 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2Bsynthetic_token' : 'https://fcm.googleapis.com/fcm/send'+path,
    p256dh:encode(await crypto.subtle.exportKey('raw',receiver.publicKey)),auth:encode(crypto.getRandomValues(new Uint8Array(16)))};
  return Response.json(await deliverNotification(destination,{type:'agentrelay.test',eventId:crypto.randomUUID()},vapid));
} };`;
const compiled = await build({ stdin: { contents: source, resolveDir: projectRoot, loader: "ts" },
  alias: { "@": path.join(projectRoot, "src") }, bundle: true, platform: "browser", format: "esm", write: false });
let requests = 0;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-05-15",
  script: compiled.outputFiles[0].text,
  // All outbound requests terminate in this synthetic provider. A followed redirect would fail the host check.
  outboundService: async request => {
    requests++;
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    assert.equal((await request.arrayBuffer()).byteLength, 4096);
    if (url.hostname.endsWith(".notify.windows.com")) {
      // Edge's push service: the token query survives intact and the VAPID audience is that service's own origin.
      assert.equal(url.href, "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2Bsynthetic_token");
      const jwt = /t=([\w-]+\.[\w-]+\.[\w-]+)/.exec(request.headers.get("authorization"))[1];
      assert.equal(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).aud, "https://wns2-par02p.notify.windows.com");
      return new Response(null, { status: 201 });
    }
    assert.equal(url.origin, "https://fcm.googleapis.com");
    return url.pathname.endsWith("/redirect") ? new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } })
      : new Response(null, { status: 201 });
  },
}));
try {
  const accepted = await (await mf.dispatchFetch("http://localhost/accepted")).json();
  assert.deepEqual(accepted, { accepted: true, disabled: false, error: null });
  assert.equal(requests, 1);
  const redirected = await (await mf.dispatchFetch("http://localhost/redirect")).json();
  assert.deepEqual(redirected, { accepted: false, disabled: false, error: "http-302" });
  assert.equal(requests, 2);
  const edge = await (await mf.dispatchFetch("http://localhost/wns")).json();
  assert.deepEqual(edge, { accepted: true, disabled: false, error: null });
  assert.equal(requests, 3);
  console.log(JSON.stringify({ passed: 4, checks: ["workerd sends a real encrypted payload", "provider acceptance is recorded", "redirects are refused without a follow-up request",
    "an Edge (WNS) endpoint keeps its token and signs for its own origin"] }));
} finally { await mf.dispose(); }
