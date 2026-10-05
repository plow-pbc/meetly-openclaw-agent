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
    assert.equal(hooks.before_tool_call!({ toolName, params: { argv: ["plow-gog", "calendar", "events", "primary"] } }, {}), undefined);
  }
  assert.equal(hooks.before_tool_call!({ toolName: "exec", params: { command: "node /opt/plow/skills/meetly/scripts/calendar.ts pending" } }, {}), undefined);
});
