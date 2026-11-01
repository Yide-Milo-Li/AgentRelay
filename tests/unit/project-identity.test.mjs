import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { projectNameKey, projectDisplayName, newProjectId, defaultProjectLine } = await loadTypeScriptModule("src/shared/formatting/project-identity.ts");

test("name keys ignore case, width, whitespace and separators", () => {
  for (const name of ["AgentRelay", "agent-relay", "Agent Relay", " agent_relay ", "agent.relay", "ＡｇｅｎｔＲｅｌａｙ"]) assert.equal(projectNameKey(name), "agentrelay", name);
  assert.equal(projectNameKey("我的 项目"), "我的项目");
  assert.notEqual(projectNameKey("web-app"), projectNameKey("web-api"));
  assert.equal(projectNameKey(" - _ . "), "");
});

test("display names are trimmed with inner whitespace collapsed", () => {
  assert.equal(projectDisplayName("  Agent \t Relay  "), "Agent Relay");
});

test("ids are opaque and distinct", () => {
  const ids = new Set(Array.from({ length: 50 }, newProjectId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^p-[a-z2-7]{10}$/);
});

test("colours spread over the least used lines and are stable per key", () => {
  assert.equal(defaultProjectLine("agentrelay", []), defaultProjectLine("agentrelay", []));
  assert.notEqual(defaultProjectLine("agentrelay", []), "neutral");
  const used = ["blue", "amber", "green", "violet", "teal"];
  assert.equal(defaultProjectLine("anything", used), "brown");
  assert.notEqual(defaultProjectLine("anything", [...used, "brown", "blue"]), "blue");
});
