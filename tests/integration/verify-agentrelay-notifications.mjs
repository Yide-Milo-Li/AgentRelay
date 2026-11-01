// Local built-Worker checks for the default-off verification release. No real push endpoint or credential is used.
import assert from "node:assert/strict";
import { testRequest } from "../support/integration-http.mjs";

const base = process.env.AGENTRELAY_TEST_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Notification checks require a local built Worker URL.");
const owner = `notification-check-${crypto.randomUUID()}`, id = crypto.randomUUID(), passed = [];
const request = (route, method = "GET", data, user = owner, extra = {}) => testRequest(base + route, {
  method, headers: { ...(user ? { "oai-authenticated-user-id": user } : {}), "Content-Type": "application/json", ...extra },
  body: data === undefined ? undefined : JSON.stringify(data),
});
const check = (label, condition) => { assert.ok(condition, label); passed.push(label); };
async function unavailable(route, data) {
  // The normal integration helper correctly rejects all 5xx; this test deliberately expects the default-off 503.
  const response = await fetch(base + route, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { "oai-authenticated-user-id": owner, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json();
  return response.status === 503 && result.error === "Browser notifications are not configured on this Site.";
}
const route = `/api/notifications?browserId=${id}`;
check("subscription status requires platform identity", (await request(route, "GET", undefined, null)).status === 401);
const state = await request(route);
check("unconfigured notification service is explicitly unavailable", state.status === 200 && state.data.available === false && state.data.publicKey === null && state.data.subscription === null);
check("invalid browser identifier is rejected", (await request("/api/notifications?browserId=invalid")).status === 400);
check("registration requires identity", (await request("/api/notifications", "PUT", { browserId: id }, null)).status === 401);
check("cross-origin registration rejected", (await request("/api/notifications", "PUT", { browserId: id }, owner, { Origin: "https://untrusted.example" })).status === 403);
const disabledRegistration = await fetch(base + "/api/notifications", { method: "PUT", redirect: "manual", signal: AbortSignal.timeout(15_000),
  headers: { "oai-authenticated-user-id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ browserId: id }) });
check("unconfigured registration fails closed", disabledRegistration.status === 503 && (await disabledRegistration.json()).error === "Browser notifications are not configured on this Site.");
check("cross-origin subscription removal rejected", (await request("/api/notifications", "DELETE", { browserId: id }, owner, { Origin: "https://untrusted.example" })).status === 403);
check("removing missing own subscription is idempotent", (await request("/api/notifications", "DELETE", { browserId: id })).status === 200);
check("test endpoint requires identity", (await request("/api/notifications/test", "POST", { browserId: id }, null)).status === 401);
check("cross-origin test rejected", (await request("/api/notifications/test", "POST", { browserId: id }, owner, { Origin: "https://untrusted.example" })).status === 403);
check("unconfigured test fails closed", await unavailable("/api/notifications/test", { browserId: id }));
check("notification metadata requires platform identity", (await request(`/api/notifications/handoffs/${crypto.randomUUID()}?browserId=${id}`, "GET", undefined, null)).status === 401);
check("missing handoff metadata is not found", (await request(`/api/notifications/handoffs/${crypto.randomUUID()}?browserId=${id}`)).status === 404);
check("JSON size ceiling applies to notification routes", (await request("/api/notifications/test", "POST", { browserId: id, oversized: "x".repeat(1_250_001) })).status === 413);
// A page answers with HTML, which the JSON request helper rightly refuses, so ask for it directly.
const retired = await fetch(base + "/notification-probe", { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "oai-authenticated-user-id": owner } });
check("the retired verification page is gone", retired.status === 404);
await retired.body?.cancel();
const script = await fetch(base + "/sw.js", { signal: AbortSignal.timeout(15_000) });
check("worker script is served as JavaScript at the origin root", script.status === 200 && /javascript/.test(script.headers.get("content-type")));
await script.body?.cancel();
console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
