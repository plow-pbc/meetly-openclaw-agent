import { test } from "node:test";
import assert from "node:assert/strict";
import { sendPolicy } from "../plugin/send-policy.js";

test("in a system turn a send with no target or no text is refused with what to add; complete sends and other actions pass", () => {
  const blocked = sendPolicy({ toolName: "message", params: { action: "send", accountId: "chat" } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.blockReason, /no target .* and no message/);
  assert.match(sendPolicy({ toolName: "message", params: { action: "send", target: "cht_owner", message: " " } })!.blockReason, /no message/);
  assert.match(sendPolicy({ toolName: "message", params: { action: "send", message: "hi" } })!.blockReason, /no target/);
  for (const params of [
    { action: "send", channel: "plow", accountId: "chat", target: "cht_owner", message: "Meetly needs your attention" },
    { action: "send", targets: ["cht_owner"], message: "hi" },
    { action: "react", target: "cht_owner" },
  ]) assert.equal(sendPolicy({ toolName: "message", params }), undefined);
  assert.equal(sendPolicy({ toolName: "exec", params: { action: "send" } }), undefined);
});

test("a turn started by a message may send to its own conversation without a target, but never without text", () => {
  const ctx = { requester: { channel: "plow", senderId: "+15550000000" } };
  assert.equal(sendPolicy({ toolName: "message", params: { action: "send", message: "May I overlap your Open Gym?" } }, ctx), undefined);
  assert.match(sendPolicy({ toolName: "message", params: { action: "send" } }, ctx)!.blockReason, /no message \(/);
  assert.doesNotMatch(sendPolicy({ toolName: "message", params: { action: "send" } }, ctx)!.blockReason, /no target/);
});
