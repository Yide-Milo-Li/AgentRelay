import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1_300_000;
const VALIDATION_ERROR = Symbol("fixture-validation-error");
const failure = (status, code) => Object.assign(new Error(code), { status, code, [VALIDATION_ERROR]: true });

/** Consume a bounded JSON body without retaining oversized input or logging SQL and row data. */
function readJson(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
      else chunks = [];
    });
    request.once("error", reject);
    request.once("aborted", () => reject(failure(400, "BODY_ABORTED")));
    request.once("end", () => {
      if (bytes > MAX_BODY_BYTES) return reject(failure(413, "BODY_TOO_LARGE"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(failure(400, "INVALID_JSON")); }
    });
  });
}

/**
 * An authenticated loopback-only test control channel. It is started only by the test preview entrypoint,
 * never imported by the application, and shares that preview's D1/R2 bindings rather than its storage files.
 */
export async function startStorageFixtureServer({ token, getD1Database, getR2Bucket }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("A fresh fixture credential is required.");
  const expected = Buffer.from(`Bearer ${token}`);
  let database, bucket;
  const server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    const json = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw failure(401, "UNAUTHORIZED");
      if (request.headers.origin) throw failure(403, "BROWSER_ORIGIN_REJECTED");
      if (request.method !== "POST") throw failure(405, "METHOD_NOT_ALLOWED");
      if (!["/sql", "/r2"].includes(request.url)) throw failure(404, "UNKNOWN_OPERATION");
      const body = await readJson(request);
      if (request.url === "/sql") {
        const statements = body?.statements;
        if (!Array.isArray(statements) || !statements.length || statements.length > 1_000
          || statements.some(sql => typeof sql !== "string" || !sql.trim())) throw failure(400, "INVALID_STATEMENTS");
        database ??= getD1Database();
        const db = await database, prepared = statements.map(sql => db.prepare(sql));
        const results = prepared.length === 1 ? [await prepared[0].all()] : await db.batch(prepared);
        json(200, results);
      } else {
        if (typeof body?.key !== "string" || !body.key || body.key.length > 2_048) throw failure(400, "INVALID_OBJECT_KEY");
        bucket ??= getR2Bucket();
        const object = await (await bucket).get(body.key);
        if (!object) return json(404, { error: { code: "OBJECT_NOT_FOUND" } });
        const bytes = Buffer.from(await object.arrayBuffer());
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
        response.end(bytes);
      }
    } catch (error) {
      // Return only fixed validation codes or known SQLite categories, never query text or result rows.
      const sqlite = ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_ERROR", "SQLITE_CONSTRAINT", "SQLITE_IOERR"]
        .find(code => String(error?.message).includes(code));
      const validation = error?.[VALIDATION_ERROR];
      json(validation ? error.status : 500, { error: { code: validation ? error.code : sqlite ?? "FIXTURE_FAILED" } });
      request.resume();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
