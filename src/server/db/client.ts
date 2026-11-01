import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/server/db/schema";
import { DEFAULT_STORAGE_LIMIT_BYTES } from "@/shared/contracts/storage";

export function getD1() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return env.DB;
}

/** The private R2 bucket holding attachment bytes; object keys never leave the server. */
export function getBucket() {
  if (!env.BUCKET) {
    throw new Error(
      "Cloudflare R2 binding `BUCKET` is unavailable. Set the `r2` field in .openai/hosting.json to `BUCKET` or let your control plane inject the real binding values before storing images."
    );
  }

  return env.BUCKET;
}

export function getDb() { return drizzle(getD1(), { schema }); }

export function storageLimitBytes() {
  const value = Number(env.AGENTRELAY_STORAGE_LIMIT_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_STORAGE_LIMIT_BYTES;
}
