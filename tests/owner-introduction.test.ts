import assert from "node:assert/strict";
import { test } from "node:test";
import { registerOwnerGroupTool } from "../plugin/owner-tools.js";

for (const introduction of ["needed", "already_introduced", undefined]) {
  test(`owner offer uses the conversation's introduction state: ${introduction}`, async () => {
    let tool: any;
    const requests: object[] = [];
    registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({}); } }, async (_ctx, args) => {
      requests.push(args);
      return { offered: [{ label: "Monday at 9 AM" }] };
    });
    const result = await tool.execute("offer", { topic: "Planning", durationMin: 30, introduction });
    if (introduction === undefined) {
      assert.equal(result.isError, true);
      assert.deepEqual(requests, []);
      return;
    }
    assert.deepEqual(requests, [{ topic: "Planning", durationMin: 30 }]);
    assert.ok(tool.parameters.required.includes("introduction"));
    const instructions = result.content.map((part: { text: string }) => part.text).join("\n");
    assert.match(instructions, introduction === "needed" ? /Introduce yourself once/ : /Do not introduce yourself or repeat your role/);
  });
}
