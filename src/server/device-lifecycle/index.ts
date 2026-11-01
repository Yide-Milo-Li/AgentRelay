import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/server/db/client";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { isUniqueViolation } from "@/server/core/sql-errors";
import { planDeviceCreate, planDeviceDelete, requireDevice, staleDevice } from "@/server/devices";
import { adoptDeviceStatements, countDeviceReferences, detachDeviceStatements } from "@/server/handoffs";
import { countUsableForDevice, releaseDeviceStatements } from "@/server/agent-tokens";
import type { DeletedDevice, Device, DeviceUsage } from "@/shared/contracts/devices";

/**
 * Creating and deleting a device touch the records that refer to it. The devices service plans its own table and each
 * referring service provides the statements for its own records; this module only puts them in one `db.batch`, which D1
 * runs as a single transaction. A table that starts referring to a device adds its statements here.
 */
type Input = Record<string, unknown>;
type Statements = BatchItem<"sqlite">[];

async function runBatch(statements: Statements): Promise<unknown[]> {
  return await getDb().batch(statements as unknown as [BatchItem<"sqlite">, ...Statements]) as unknown as unknown[];
}

export async function getDeviceDetail(owner: string, id: string): Promise<{ device: Device; usage: DeviceUsage }> {
  const device = await requireDevice(owner, id);
  const [handoffs, connections] = await Promise.all([countDeviceReferences(owner, id), countUsableForDevice(owner, id)]);
  return { device, usage: { totalHandoffs: handoffs.total, openHandoffs: handoffs.open, connections } };
}

export async function createDevice(owner: string, input: Input): Promise<Device> {
  const plan = await planDeviceCreate(owner, input);
  // Legacy handoffs only carry names. Adopting the ones this device now answers to rides in the insert's batch, so a
  // create that loses a race on the id adopts nothing.
  try { await runBatch([plan.insert, ...adoptDeviceStatements(owner, plan.key, plan.registered)]); }
  catch (error) {
    if (isUniqueViolation(error)) throw new AgentRelayError("That device already exists or was just created elsewhere. Refresh and try again.", 409);
    throw error;
  }
  return plan.device;
}

/**
 * Delete a device and detach everything that points at it, atomically. D1 has no interactive transactions, so one batch
 * is the unit: every detaching statement carries the guard that the device still has the version the caller saw, and the
 * final delete is the compare-and-swap that reports a stale caller.
 */
export async function deleteDevice(owner: string, id: string, input: Input, by: string | null = null): Promise<DeletedDevice> {
  const plan = await planDeviceDelete(owner, id, input);
  const handoffs = detachDeviceStatements(owner, plan.device, plan.guard);
  const connections = releaseDeviceStatements(owner, id, plan.guard, { revoke: plan.connections === "revoke", by, now: Date.now() });
  const results = await runBatch([...handoffs.statements, ...connections.statements, plan.remove]);
  const split = handoffs.statements.length, end = split + connections.statements.length;
  if (!(results[end] as unknown[]).length) throw staleDevice();
  const released = connections.read(results.slice(split, end));
  return { id, detachedHandoffs: handoffs.read(results.slice(0, split)), revokedConnections: released.revoked, unboundConnections: released.unbound };
}
