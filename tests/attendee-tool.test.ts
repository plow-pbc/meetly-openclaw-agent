import assert from "node:assert/strict";
import { test } from "node:test";
import * as ownerTools from "../plugin/owner-tools.js";

const owner = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true,
  requesterSenderId: "+15550001111", nativeChannelId: "owner-dm", sessionKey: "agent:main:main" };

for (const change of [null, { senderIsOwner: false }, { requesterSenderId: undefined },
  { nativeChannelId: undefined }, { messageChannel: "webchat" }, { agentAccountId: "unknown" }]) {
  test(`structured attendee edits require runtime owner identity: ${JSON.stringify(change)}`, async () => {
    let tool: any;
    const calls: unknown[] = [];
    assert.equal(typeof ownerTools.registerAttendeeTool, "function");
    ownerTools.registerAttendeeTool({ registerTool(factory: any) { tool = factory({ ...owner, ...change }); } }, async (context: unknown, args: unknown) => {
      calls.push({ context, args });
      return { invitationUpdated: true, confirmationTime: "Mon, Oct 5, 10:00 AM UTC" };
    });
    const email = "guest'$(touch /tmp/meetly-injection)'@example.com";
    const result = await tool.execute("edit", { requestId: "request", operation: "add", email, senderIsOwner: true });
    assert.equal(result.isError, change !== null);
    assert.equal(calls.length, change === null ? 1 : 0);
    if (change === null) {
      assert.deepEqual(calls, [{ context: owner, args: { requestId: "request", operation: "add", email, senderIsOwner: true } }]);
      assert.equal(result.details.confirmationTime, "Mon, Oct 5, 10:00 AM UTC");
      assert.deepEqual(tool.parameters.required, ["requestId", "operation", "email"]);
      assert.equal(tool.parameters.properties.senderIsOwner, undefined);
      assert.deepEqual(tool.parameters.properties.operation.enum, ["add"]);
    }
  });
}
