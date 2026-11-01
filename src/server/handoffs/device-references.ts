import { and, count, eq, gt, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/server/db/client";
import { handoffs } from "@/server/db/schema";

/**
 * How handoffs follow the device registry. The `*_device_id` columns and their name snapshots belong to this service:
 * whoever creates or deletes a device asks for these statements and runs them in its own batch, guarded by the
 * device's own condition. Detaching does not bump `handoffs.version`.
 */

/** Adopt legacy handoffs that only carry a name this device now answers to. `registered` holds once the device row exists. */
export function adoptDeviceStatements(owner: string, device: { id: string; nameKey: string }, registered: SQL): BatchItem<"sqlite">[] {
  const db = getDb(), matches = [...new Set([device.nameKey, device.id])];
  return [
    db.update(handoffs).set({ sourceDeviceId: device.id }).where(and(eq(handoffs.ownerId, owner), isNull(handoffs.sourceDeviceId), inArray(sql`lower(trim(${handoffs.sourceDevice}))`, matches), registered)),
    db.update(handoffs).set({ targetDeviceId: device.id }).where(and(eq(handoffs.ownerId, owner), isNull(handoffs.targetDeviceId), inArray(sql`lower(trim(${handoffs.targetDevice}))`, matches), registered)),
    db.update(handoffs).set({ claimedByDeviceId: device.id }).where(and(eq(handoffs.ownerId, owner), isNull(handoffs.claimedByDeviceId), inArray(sql`lower(trim(${handoffs.claimedBy}))`, matches), registered)),
  ];
}

/**
 * Turn the references to a device into plain names: the snapshot takes the device's current name and the id is cleared.
 * `read` receives the results of these statements, in order, and returns how many distinct handoffs were detached.
 */
export function detachDeviceStatements(owner: string, device: { id: string; name: string }, guard: SQL) {
  const db = getDb();
  const statements: BatchItem<"sqlite">[] = [
    db.update(handoffs).set({ sourceDevice: device.name, sourceDeviceId: null })
      .where(and(eq(handoffs.ownerId, owner), eq(handoffs.sourceDeviceId, device.id), guard)).returning({ id: handoffs.id }),
    db.update(handoffs).set({ targetDevice: device.name, targetDeviceId: null })
      .where(and(eq(handoffs.ownerId, owner), eq(handoffs.targetDeviceId, device.id), guard)).returning({ id: handoffs.id }),
    db.update(handoffs).set({ claimedBy: device.name, claimedByDeviceId: null })
      .where(and(eq(handoffs.ownerId, owner), eq(handoffs.claimedByDeviceId, device.id), guard)).returning({ id: handoffs.id }),
  ];
  const read = (results: readonly unknown[]) => new Set((results as { id: string }[][]).flat().map(row => row.id)).size;
  return { statements, read };
}

/** How many handoffs name the device on any side, and how many of those are still open (not done, not expired). */
export async function countDeviceReferences(owner: string, id: string): Promise<{ total: number; open: number }> {
  const db = getDb(), now = Date.now();
  const refers = or(eq(handoffs.sourceDeviceId, id), eq(handoffs.targetDeviceId, id), eq(handoffs.claimedByDeviceId, id));
  const [[total], [open]] = await Promise.all([
    db.select({ n: count() }).from(handoffs).where(and(eq(handoffs.ownerId, owner), refers)),
    db.select({ n: count() }).from(handoffs).where(and(eq(handoffs.ownerId, owner), refers, ne(handoffs.status, "done"), or(isNull(handoffs.expiresAt), gt(handoffs.expiresAt, now)))),
  ]);
  return { total: total.n, open: open.n };
}
