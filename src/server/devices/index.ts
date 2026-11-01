import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/server/db/client";
import { devices } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { MAX_DEVICES, type Device, type DeviceConnectionAction, type DeviceLine } from "@/shared/contracts/devices";
import { defaultDeviceLine, indexDevices, lookupDevice, suggestDeviceId } from "@/shared/formatting/device-identity";
import { assertNoConflicts, parseConnectionAction, parseDeviceId, parseDeviceLine, parseDeviceName, parseVersion } from "./validation";

type Input = Record<string, unknown>;
type PublicRow = { id: string; name: string; line: string; createdAt: number; updatedAt: number; version: number };

const publicFields = {
  id: devices.id, name: devices.name, line: devices.line,
  createdAt: devices.createdAt, updatedAt: devices.updatedAt, version: devices.version,
};
const asDevice = (row: PublicRow): Device =>
  ({ id: row.id, name: row.name, line: row.line as DeviceLine, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.version });
const stale = () => new AgentRelayError("This device was just changed elsewhere. Refresh and try again.", 409);
/** The error for a caller whose device version no longer matches. Exported for the code that runs the batch. */
export const staleDevice = stale;

function ownedRows(owner: string) {
  return getDb().select().from(devices).where(eq(devices.ownerId, owner)).orderBy(asc(devices.createdAt), asc(devices.id));
}
function isUniqueViolation(error: unknown) {
  const text = [(error as Error)?.message, (error as { cause?: Error })?.cause?.message].join(" ");
  return /UNIQUE constraint failed/i.test(text);
}
/** True only while the device row still has the version the caller read. Batched writes use it as their CAS guard. */
function deviceAtVersion(owner: string, id: string, version: number) {
  return sql`exists (select 1 from ${devices} where ${devices.ownerId} = ${owner} and ${devices.id} = ${id} and ${devices.version} = ${version})`;
}

export async function listDevices(owner: string): Promise<Device[]> {
  return (await ownedRows(owner)).map(asDevice);
}

export async function requireDevice(owner: string, id: string): Promise<Device> {
  const [row] = await getDb().select().from(devices).where(and(eq(devices.ownerId, owner), eq(devices.id, id))).limit(1);
  if (!row) throw new AgentRelayError("This device doesn't exist.", 404);
  return asDevice(row);
}

/** Resolve device ids or names in one query. Unregistered references map to undefined. */
export async function resolveDeviceRefs(owner: string, refs: readonly string[]): Promise<Map<string, Device | undefined>> {
  const index = indexDevices(await listDevices(owner));
  return new Map(refs.map(ref => [ref, lookupDevice(index, ref)]));
}

/**
 * A validated device creation, ready to be run. This service only plans its own table: whoever runs the batch
 * adds the statements of the records that refer to a device. `registered` holds only once the insert has applied,
 * so statements guarded by it do nothing when the create loses a race on the id.
 */
export type DeviceCreatePlan = { device: Device; key: { id: string; nameKey: string }; insert: BatchItem<"sqlite">; registered: SQL };

export async function planDeviceCreate(owner: string, input: Input): Promise<DeviceCreatePlan> {
  const { name, key } = parseDeviceName(input.name);
  const rows = await ownedRows(owner);
  if (rows.length >= MAX_DEVICES) throw new AgentRelayError("You can register up to 50 devices.", 409);
  const id = input.id == null || input.id === "" ? suggestDeviceId(name, rows.flatMap(row => [row.id, row.nameKey])) : parseDeviceId(input.id);
  const line = input.line == null ? defaultDeviceLine(name, rows.map(row => row.line as DeviceLine)) : parseDeviceLine(input.line);
  assertNoConflicts(rows, { id, nameKey: key });
  const now = Date.now();
  return {
    device: { id, name, line, createdAt: now, updatedAt: now, version: 1 }, key: { id, nameKey: key },
    insert: getDb().insert(devices).values({ ownerId: owner, id, name, nameKey: key, line, createdAt: now, updatedAt: now, version: 1 }),
    registered: sql`exists (select 1 from ${devices} where ${devices.ownerId} = ${owner} and ${devices.id} = ${id})`,
  };
}

export async function updateDevice(owner: string, id: string, input: Input): Promise<Device> {
  if (input.id !== undefined && input.id !== id) throw new AgentRelayError("A device id can't be changed after it is created.");
  const version = parseVersion(input);
  if (input.name === undefined && input.line === undefined) throw new AgentRelayError("Change at least the name or the colour.");
  const rows = await ownedRows(owner), row = rows.find(item => item.id === id);
  if (!row) throw new AgentRelayError("This device doesn't exist.", 404);
  if (row.version !== version) throw stale();
  const patch: { name?: string; nameKey?: string; line?: string } = {};
  if (input.name !== undefined) {
    const { name, key } = parseDeviceName(input.name);
    assertNoConflicts(rows.filter(item => item.id !== id), { id, nameKey: key });
    patch.name = name; patch.nameKey = key;
  }
  if (input.line !== undefined) patch.line = parseDeviceLine(input.line);
  try {
    // Compare-and-swap on the version read above: a concurrent edit leaves no row to update.
    const [updated] = await getDb().update(devices).set({ ...patch, updatedAt: Date.now(), version: row.version + 1 })
      .where(and(eq(devices.ownerId, owner), eq(devices.id, id), eq(devices.version, row.version))).returning(publicFields);
    if (!updated) throw stale();
    return asDevice(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AgentRelayError("A device with that name already exists.", 409);
    throw error;
  }
}

/**
 * A validated device deletion. `guard` holds only while the device still has the version the caller saw: every
 * statement that detaches a referring record carries it, and `remove` is the compare-and-swap that reports a stale
 * caller (its result is empty when the version had moved).
 */
export type DeviceDeletePlan = { device: Device; connections: DeviceConnectionAction; guard: SQL; remove: BatchItem<"sqlite"> };

export async function planDeviceDelete(owner: string, id: string, input: Input): Promise<DeviceDeletePlan> {
  const version = parseVersion(input), connections = parseConnectionAction(input.connections);
  const device = await requireDevice(owner, id);
  if (device.version !== version) throw stale();
  return {
    device, connections, guard: deviceAtVersion(owner, id, version),
    remove: getDb().delete(devices).where(and(eq(devices.ownerId, owner), eq(devices.id, id), eq(devices.version, version))).returning({ id: devices.id }),
  };
}
