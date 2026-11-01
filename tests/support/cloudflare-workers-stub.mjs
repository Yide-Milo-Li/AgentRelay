// Test-only stand-in for the `cloudflare:workers` module. Tests assign `env.DB` and `env.BUCKET` before calling a service.
export const env = {};
// Work handed to `waitUntil` is kept so a test can await what a real Worker would finish after the response.
export const scheduled = [];
export function waitUntil(task) { scheduled.push(task); }
