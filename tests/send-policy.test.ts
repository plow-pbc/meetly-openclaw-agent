import { test } from "node:test";
import assert from "node:assert/strict";
import { sendPolicy } from "../plugin/send-policy.js";

test("a send with no target or no text is refused with what to add; complete sends and other actions pass", () => {
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
