import assert from "node:assert/strict";
import { test } from "node:test";
import { registerOwnerGroupTool } from "../plugin/owner-tools.js";

for (const introduction of ["needed", "already_introduced"]) test(`group offers carry an explicit introduction decision: ${introduction}`, async () => {
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({}); } }, async () => ({ offered: [{ label: "Tue 9 AM PDT" }] }));
  const result = await tool.execute("offer", { topic: "Call", durationMin: 30, introduction });
  const instruction = result.content.slice(1).map((part: any) => part.text).join("\n");
  assert.match(instruction, introduction === "needed" ? /Introduce yourself once/ : /Do not introduce yourself/);
  assert.ok(tool.parameters.required.includes("introduction"));
});

for (const introduction of [undefined, "guess"]) test(`missing or invalid introduction decisions cannot create holds: ${introduction}`, async () => {
  let tool: any, calls = 0;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({}); } }, async () => { calls++; return { offered: [] }; });
  const result = await tool.execute("offer", { topic: "Call", durationMin: 30, introduction });
  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /introduction/);
});
