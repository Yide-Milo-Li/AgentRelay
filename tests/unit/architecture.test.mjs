import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSources } from "../../tooling/architecture/check.mjs";

const analyze = files => analyzeSources(new Map(Object.entries(files)));

test("public feature entrypoints may consume browser-safe contracts", () => {
  assert.deepEqual(analyze({
    "src/app/page.tsx": 'import { Inbox } from "@/features/handoffs";',
    "src/features/handoffs/index.ts": 'export const Inbox = () => null;',
  }), []);
});

test("client graphs reject server imports hidden behind re-exports", () => {
  const errors = analyze({
    "src/app/_components/Inbox.tsx": '"use client"; import { db } from "./bridge";',
    "src/app/_components/bridge.ts": 'export { db } from "@/server/db/client";',
    "src/server/db/client.ts": 'export const db = {};',
  });
  assert.ok(errors.some(error => error.includes("client import graph reaches")));
});

test("relative and dynamic imports cannot bypass runtime or feature boundaries", () => {
  const errors = analyze({
    "src/features/handoffs/api.ts": 'import("../../../tooling/helper.mjs"); import "../agent-access/internal";',
    "src/features/agent-access/internal.ts": 'export const value = 1;',
    "tooling/helper.mjs": 'export const value = 1;',
  });
  assert.ok(errors.some(error => error.includes("runtime code cannot import tooling")));
  assert.ok(errors.some(error => error.includes("features cannot import another feature")));
});

test("type imports and bare Node names follow runtime restrictions", () => {
  const errors = analyze({
    "src/shared/contracts/handoff.ts": 'type Schema = import("../../server/db/schema").Schema; import "fs";',
    "src/server/db/schema.ts": 'export type Schema = {}',
  });
  assert.ok(errors.some(error => error.includes("pure shared modules")));
  assert.ok(errors.some(error => error.includes("Node builtin is forbidden")));
});

test("cross-feature deep imports, computed imports, and cycles fail", () => {
  const errors = analyze({
    "src/app/page.tsx": 'import "@/features/handoffs/internal"; import(name);',
    "src/features/handoffs/internal.ts": 'import "./other";',
    "src/features/handoffs/other.ts": 'export * from "./internal";',
  });
  assert.ok(errors.some(error => error.includes("public index")));
  assert.ok(errors.some(error => error.includes("computed runtime imports")));
  assert.ok(errors.some(error => error.includes("dependency cycle")));
});

test("services may use the devices service only through its public index", () => {
  const sources = {
    "src/server/devices/index.ts": 'import "@/server/db/schema"; import "@/server/core/agent-relay-error"; import "./validation";',
    "src/server/devices/validation.ts": 'export const rules = {};',
    "src/server/db/schema.ts": 'export const schema = {};',
    "src/server/core/agent-relay-error.ts": 'export class AgentRelayError {}',
  };
  assert.deepEqual(analyze({
    ...sources,
    "src/server/handoffs/index.ts": 'import { listDevices } from "@/server/devices";',
    "src/server/agent-tokens/index.ts": 'import { requireDevice } from "@/server/devices";',
  }), []);
  const deep = analyze({ ...sources, "src/server/handoffs/index.ts": 'import "@/server/devices/validation";' });
  assert.ok(deep.some(error => error.includes("public index")));
});

test("the devices service cannot depend on the services that depend on it", () => {
  const errors = analyze({
    "src/server/devices/index.ts": 'import "@/server/handoffs"; import "@/server/agent-tokens"; import "@/server/http";',
    "src/server/handoffs/index.ts": 'export const handoffs = 1;',
    "src/server/agent-tokens/index.ts": 'export const tokens = 1;',
    "src/server/http/index.ts": 'export const http = 1;',
  });
  assert.equal(errors.filter(error => error.includes("server dependency direction")).length, 3);
});

test("handoffs reach the projects service only through its index, and projects depend on no other service", () => {
  const sources = {
    "src/server/projects/index.ts": 'import "@/server/db/schema"; import "@/server/core/agent-relay-error"; import "./validation";',
    "src/server/projects/validation.ts": 'export const rules = {};',
    "src/server/db/schema.ts": 'export const schema = {};',
    "src/server/core/agent-relay-error.ts": 'export class AgentRelayError {}',
  };
  assert.deepEqual(analyze({ ...sources, "src/server/handoffs/index.ts": 'import { prepareProjectLink } from "@/server/projects";' }), []);
  assert.ok(analyze({ ...sources, "src/server/handoffs/index.ts": 'import "@/server/projects/validation";' }).some(error => error.includes("public index")));
  const reverse = analyze({ ...sources, "src/server/projects/index.ts": 'import "@/server/handoffs"; import "@/server/devices";',
    "src/server/handoffs/index.ts": 'export const handoffs = 1;', "src/server/devices/index.ts": 'export const devices = 1;' });
  assert.equal(reverse.filter(error => error.includes("server dependency direction")).length, 2);
});

test("the MCP adapter and the browser cannot reach the devices service directly", () => {
  const errors = analyze({
    "src/server/mcp/index.ts": 'import "@/server/devices";',
    "src/features/devices/index.ts": 'import "@/server/devices";',
    "src/server/devices/index.ts": 'export const devices = 1;',
  });
  assert.ok(errors.some(error => error.startsWith("src/server/mcp/index.ts") && error.includes("server dependency direction")));
  assert.ok(errors.some(error => error.startsWith("src/features/devices/index.ts") && error.includes("features can only use")));
});

test("only the existing connector context may import node:async_hooks", () => {
  assert.deepEqual(analyze({"src/platform/connectors/connector-context.ts": 'import "node:async_hooks";'}), []);
  assert.ok(analyze({"src/server/auth/index.ts": 'import "node:async_hooks";'}).length);
});

test("JSON data imported by runtime code resolves when present and fails when missing", () => {
  assert.deepEqual(analyze({
    "src/shared/agent-profiles/index.ts": 'import data from "./profiles.json"; export default data;',
    "src/shared/agent-profiles/profiles.json": '{"profiles":[]}',
  }), []);
  assert.ok(analyze({ "src/shared/agent-profiles/index.ts": 'import data from "./profiles.json"; export default data;' })
    .some(error => error.includes("unresolved local import")));
});

test("services reach attachments only through its public index; attachments depends on nothing above it", () => {
  const base = {
    "src/server/attachments/index.ts": 'import "./validation"; import "@/server/db/client"; export const a = 1;',
    "src/server/attachments/validation.ts": 'export const v = 1;',
    "src/server/db/client.ts": 'export const db = 1;',
  };
  assert.deepEqual(analyze({ ...base, "src/server/handoffs/index.ts": 'import "@/server/attachments";', "src/server/mcp/index.ts": 'import "@/server/attachments";' }), []);
  assert.ok(analyze({ ...base, "src/server/handoffs/index.ts": 'import "@/server/attachments/validation";' }).some(error => error.includes("public index")));
  assert.ok(analyze({ ...base, "src/server/attachments/index.ts": 'import "@/server/handoffs";', "src/server/handoffs/index.ts": 'export const h = 1;' })
    .some(error => error.includes("server dependency direction")));
  assert.ok(analyze({ ...base, "src/server/devices/index.ts": 'import "@/server/attachments";' }).some(error => error.includes("server dependency direction")));
});

test("the browser, features and pure shared code cannot import the attachments service; the image inspector stays pure", () => {
  const server = { "src/server/attachments/index.ts": 'export const a = 1;' };
  assert.ok(analyze({ ...server, "src/features/handoffs/index.ts": 'import "@/server/attachments";' }).some(error => error.includes("features can only use")));
  assert.ok(analyze({ ...server, "src/shared/images/inspect-image.mjs": 'import "../../server/attachments";' }).some(error => error.includes("pure shared modules")));
  assert.ok(analyze({ "src/shared/images/inspect-image.mjs": 'import "node:fs";' }).some(error => error.includes("Node builtin is forbidden")));
  assert.deepEqual(analyze({
    "src/shared/contracts/attachments.ts": 'import { IMAGE_LIMITS } from "@/shared/images/inspect-image.mjs"; export { IMAGE_LIMITS };',
    "src/shared/images/inspect-image.mjs": 'export const IMAGE_LIMITS = {};',
  }), []);
});

test("runtime code cannot import the Node uploader tooling", () => {
  assert.ok(analyze({
    "src/server/attachments/index.ts": 'import "../../../tooling/agents/upload-attachments.mjs";',
    "tooling/agents/upload-attachments.mjs": 'import "node:fs";',
  }).some(error => error.includes("runtime code cannot import tooling")));
});

test("only device-lifecycle composes the services that refer to a device, and only through their public indexes", () => {
  const services = {
    "src/server/devices/index.ts": 'import "./validation"; export const devices = 1;', "src/server/devices/validation.ts": 'export const rules = {};',
    "src/server/handoffs/index.ts": 'export const handoffs = 1;', "src/server/handoffs/device-references.ts": 'export const refs = 1;',
    "src/server/agent-tokens/index.ts": 'export const tokens = 1;', "src/server/db/client.ts": 'export const db = {};',
    "src/server/core/sql-errors.ts": 'export const e = 1;',
  };
  assert.deepEqual(analyze({
    ...services,
    "src/server/device-lifecycle/index.ts": 'import "@/server/devices"; import "@/server/handoffs"; import "@/server/agent-tokens"; import "@/server/db/client"; import "@/server/core/sql-errors";',
    "src/app/api/devices/route.ts": 'import "@/server/device-lifecycle";',
  }), []);
  const deep = analyze({ ...services, "src/server/device-lifecycle/index.ts": 'import "@/server/handoffs/device-references"; import "@/server/devices/validation";' });
  assert.equal(deep.filter(error => error.includes("public index")).length, 2);
  for (const area of ["devices", "handoffs", "agent-tokens", "mcp", "auth"]) {
    const reverse = analyze({ ...services, "src/server/device-lifecycle/index.ts": 'export const lifecycle = 1;', "src/server/mcp/index.ts": 'export const mcp = 1;', "src/server/auth/index.ts": 'export const auth = 1;',
      [`src/server/${area}/index.ts`]: 'import "@/server/device-lifecycle";' });
    assert.ok(reverse.some(error => error.includes("server dependency direction")), area);
  }
});
