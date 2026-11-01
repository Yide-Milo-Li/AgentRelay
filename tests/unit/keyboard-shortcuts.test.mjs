import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the production policy without a DOM framework or a runtime-only test dependency.
const source = await readFile(new URL("../../src/shared/browser/keyboard-shortcuts.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { matchesShortcut, adjacentItemIndex } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const context = { characters: true, editing: false, blocked: false };
const key = (value, overrides = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, ...overrides });

test("character shortcuts do not consume typing, disabled preferences, or background layers", () => {
  for (const [action, value] of [
    ["tabInbox", "1"], ["tabDone", "2"], ["tabDevices", "3"], ["tabAgents", "4"], ["tabSettings", "5"],
    ["search", "/"], ["create", "n"], ["next", "j"], ["previous", "k"], ["copy", "y"], ["help", "?"]
  ]) {
    assert.equal(matchesShortcut(action, key(value), context), true);
    for (const override of [{ editing: true }, { characters: false }, { blocked: true }]) {
      assert.equal(matchesShortcut(action, key(value), { ...context, ...override }), false);
    }
  }
});

test("IME sessions, legacy composition events, long presses and consumed events never trigger actions", () => {
  for (const override of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
    assert.equal(matchesShortcut("create", key("n", override), context), false);
    assert.equal(matchesShortcut("send", key("Enter", { ctrlKey: true, ...override }), context), false);
    assert.equal(matchesShortcut("escape", key("Escape", override), context), false);
  }
});

test("native modifier chords and unassigned shifted letters are preserved, while question mark remains available", () => {
  for (const override of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(matchesShortcut("copy", key("y", override), context), false);
  }
  assert.equal(matchesShortcut("help", key("?", { shiftKey: true }), context), true);
  assert.equal(matchesShortcut("create", key("N"), context), true);
  assert.equal(matchesShortcut("create", key("j"), context), false);
});

test("lifecycle shortcuts require explicit Shift and obey every character-shortcut guard", () => {
  for (const [action, value] of [["claim", "c"], ["complete", "d"]]) {
    const shifted = key(value.toUpperCase(), { shiftKey: true });
    assert.equal(matchesShortcut(action, shifted, context), true);
    assert.equal(matchesShortcut(action, key(value), context), false);
    // Caps Lock changes key casing but cannot substitute for holding Shift.
    assert.equal(matchesShortcut(action, key(value.toUpperCase()), context), false);
    for (const override of [{ editing: true }, { characters: false }, { blocked: true }]) {
      assert.equal(matchesShortcut(action, shifted, { ...context, ...override }), false);
    }
    for (const override of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
      assert.equal(matchesShortcut(action, { ...shifted, ...override }, context), false);
    }
  }
});

test("send requires exactly Ctrl or Meta; disabling characters preserves send and Escape", () => {
  const editing = { ...context, characters: false, editing: true };
  for (const override of [{ ctrlKey: true }, { metaKey: true }]) assert.equal(matchesShortcut("send", key("Enter", override), editing), true);
  for (const override of [{}, { ctrlKey: true, metaKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true, shiftKey: true }]) {
    assert.equal(matchesShortcut("send", key("Enter", override), editing), false);
  }
  assert.equal(matchesShortcut("escape", key("Escape"), editing), true);
  assert.equal(matchesShortcut("open", key("Enter"), editing), false);
  assert.equal(matchesShortcut("open", key("Enter"), { ...editing, editing: false }), true);
});

test("undo requires exactly Ctrl or Meta, survives the single-key preference, and leaves text fields their own undo", () => {
  for (const override of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(matchesShortcut("undo", key("z", override), context), true);
    assert.equal(matchesShortcut("undo", key("Z", override), { ...context, characters: false }), true);
    assert.equal(matchesShortcut("undo", key("z", override), { ...context, editing: true }), false);
    assert.equal(matchesShortcut("undo", key("z", override), { ...context, blocked: true }), false);
  }
  // Plain Z, redo (Shift), AltGr and mixed chords never undo a status.
  for (const override of [{}, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }, { ctrlKey: true, repeat: true }]) {
    assert.equal(matchesShortcut("undo", key("z", override), context), false);
  }
});

test("filtered list navigation handles emptiness, removed selections and both boundaries without wrapping", () => {
  assert.equal(adjacentItemIndex(0, -1, 1), null);
  assert.equal(adjacentItemIndex(0, -1, -1), null);
  assert.equal(adjacentItemIndex(3, -1, 1), 0);
  assert.equal(adjacentItemIndex(3, 0, -1), 0);
  assert.equal(adjacentItemIndex(3, 0, 1), 1);
  assert.equal(adjacentItemIndex(3, 2, 1), 2);
  assert.equal(adjacentItemIndex(1, 0, 1), 0);
});
