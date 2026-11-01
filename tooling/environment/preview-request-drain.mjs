// Local workerd can reset service-binding connections when an early response leaves a transferred body unread.
// Keep one branch outside the framework's Request adapters, without changing production request handling.
export async function previewFetch(worker, request, env, context, { maxBytes = 2_600_000, timeoutMs = 5_000 } = {}) {
  if (!request.body) return worker.fetch(request, env, context);
  const forwarded = request.clone(), reader = request.body.getReader();
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve("deadline"), timeoutMs); });
  const drain = (async () => {
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk === "deadline") return;
        if (chunk.done) return;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) return;
      }
    } catch { /* A disconnected upload must not replace the application's response. */ }
    finally {
      clearTimeout(timer);
      // Tee cancellation may wait for the other branch. Do not await it after an early refusal.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
  try { return await worker.fetch(forwarded, env, context); }
  finally { await drain; }
}
