import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../plugin/index.js";

test("model-issued raw calendar writes are blocked, while reads and the seam remain available", () => {
  const hooks: Record<string, Function> = {};
  plugin.register({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool() {}, logger: { info() {} } });
  for (const toolName of ["plow__plow_run_command", "plow_run_command"]) {
    for (const verb of ["create", "update", "delete"]) {
      const result = hooks.before_tool_call!({ toolName, params: { argv: ["plow-gog", "calendar", verb, "primary", "--summary", "Test hold"] } }, {});
      assert.equal(result?.block, true);
      assert.match(result.blockReason, /calendar.ts/);
    }
    for (const verb of ["calendars", "events", "event", "list", "ls", "freebusy", "conflicts"]) {
      assert.equal(hooks.before_tool_call!({ toolName, params: { argv: ["plow-gog", "calendar", verb, "primary"] } }, {}), undefined);
      assert.equal(hooks.before_tool_call!({ toolName, params: { argv: ["plow-gog", "--account", "owner@example.com", "cal", "--json", verb] } }, {}), undefined);
    }
  }
  assert.equal(hooks.before_tool_call!({ toolName: "plow_run_command", params: { argv: ["plow-gog", "gmail", "search", "calendar"] } }, {}), undefined);
  assert.equal(hooks.before_tool_call!({ toolName: "exec", params: { command: "node /opt/plow/skills/meetly/scripts/calendar.ts pending" } }, {}), undefined);
});

for (const executable of ["plow-gog", "gog"]) {
  for (const group of ["calendar", "cal"]) {
    test(`raw calendar writes deny aliases and flag placement through ${executable} ${group}`, () => {
      const hooks: Record<string, Function> = {};
      plugin.register({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool() {}, logger: { info() {} } });
      for (const verb of ["create", "add", "new", "update", "edit", "delete", "remove", "rm", "respond", "unknown-future-command"]) {
        for (const argv of [
          [executable, group, verb, "primary"],
          [executable, "--account", "owner@example.com", group, verb],
          [executable, "-aowner@example.com", group, "--json", verb],
          [executable, group, "--account=owner@example.com", verb],
          [executable, "--json", group, verb, "--account", "owner@example.com"],
        ]) assert.equal(hooks.before_tool_call!({ toolName: "plow_run_command", params: { argv } }, {})?.block, true, JSON.stringify(argv));
      }
    });
  }
}

test("all model-issued AppleScript is blocked regardless of source or target", () => {
  const hooks: Record<string, Function> = {};
  plugin.register({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool() {}, logger: { info() {} } });
  for (const toolName of ["plow_run_applescript", "plow__plow_run_applescript"]) {
    for (const params of [
      { app: "Calendar", script: 'tell application "Calendar" to make new event' },
      { app: "com.apple.iCal", script: 'make new event' },
      { app: "/System/Applications/Calendar.app", script: 'make new event' },
      { app: "System Events", script: 'tell application id "com.apple.iCal" to make new event' },
      { app: "System Events", script: 'tell application "calendar" to delete every event' },
    ]) assert.equal(hooks.before_tool_call!({ toolName, params }, {})?.block, true, JSON.stringify(params));
    assert.equal(hooks.before_tool_call!({ toolName, params: { app: "Finder", script: 'tell application ("Cal" & "endar") to activate' } }, {})?.block, true);
  }
});


test("model commands cannot request Apple events even outside gog", () => {
  const hooks: Record<string, Function> = {};
  plugin.register({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool() {}, logger: { info() {} } });
  for (const toolName of ["plow_run_command", "plow__plow_run_command"]) {
    for (const argv of [["/usr/bin/osascript", "-e", 'tell application ("Cal" & "endar") to activate'], ["plow-gog", "calendar", "events"], ["custom-helper"]]) {
      assert.equal(hooks.before_tool_call!({ toolName, params: { argv, apple_events: true } }, {})?.block, true);
    }
    assert.equal(hooks.before_tool_call!({ toolName, params: { argv: ["plow-gog", "calendar", "events"], apple_events: false } }, {}), undefined);
  }
});
