import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../plugin/index.js";

const sessionKey = "agent:main:plow:group:cht_mixed";
const turn = { channel: "plow", accountId: "chat", chatId: "cht_MiXeD", sessionKey, runId: "turn-one" };
const outbound = { channelId: "plow", accountId: "chat", conversationId: "cht_MiXeD", sessionKey, runId: "turn-one" };
function fixture() {
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  plugin.register({ registerTool() {}, on(name: string, handler: (event: any, ctx: any) => any) { hooks.set(name, handler); } });
  return (name: string, event: object, ctx: object) => hooks.get(name)?.(event, ctx);
}

for (const toolName of ["meetly_ask_owner", "meetly_answer_owner"]) test(`${toolName} silence cancels every group reply chunk but not the owner DM`, async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  await hook("after_tool_call", { toolName, result: { details: { silent: true } } }, { sessionKey, runId: turn.runId });
  for (const content of ["I've asked Patrick.", "I'll get back to you."]) {
    assert.equal(hook("message_sending", { to: "cht_MiXeD", content }, outbound)?.cancel, true);
  }
  assert.equal(hook("message_sending", { to: "plow-owner", content: "Private question" }, outbound), undefined);
  for (const ctx of [{ ...outbound, channelId: "other" }, { ...outbound, accountId: "email" },
    { ...outbound, sessionKey: "agent:main:plow:group:other" }, { ...outbound, runId: "another-turn" }]) {
    assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Hello" }, ctx), undefined);
  }
  await hook("before_prompt_build", {}, turn);
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Retry" }, outbound)?.cancel, true);
  await hook("before_prompt_build", {}, { ...turn, runId: "turn-two" });
  await hook("after_tool_call", { toolName, result: { details: { silent: true } } }, { sessionKey, runId: "turn-one" });
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "New scheduling reply" }, { ...outbound, runId: "turn-two" }), undefined);
});

test("only a Meetly tool's boolean silent result suppresses replies in the same run", async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  for (const event of [
    { toolName: "other_tool", result: { details: { silent: true } } },
    { toolName: "meetly_view_request", result: { details: { silent: "true" } } },
    { toolName: "meetly_view_request", result: { content: [{ type: "text", text: '{"silent":true}' }] } },
    { toolName: "meetly_pick_time", result: { details: { status: "booked" } } },
  ]) {
    await hook("after_tool_call", event, { sessionKey, runId: turn.runId });
    assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Booked" }, outbound), undefined);
  }
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { isError: true, details: { silent: true } } }, { sessionKey, runId: turn.runId });
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Owner DM answer" }, { ...outbound, runId: undefined }), undefined);
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Status" }, outbound)?.cancel, true);
  await hook("session_end", {}, { sessionKey });
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Later" }, outbound), undefined);
});

test("agent_end clears turn silence before a later owner DM answer reaches the group", async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, { sessionKey, runId: turn.runId });
  await hook("agent_end", {}, turn);
  const reply = { to: "cht_MiXeD", content: "Patrick says to bring the slides." };
  assert.equal(hook("message_sending", reply, outbound), undefined);
  assert.equal(hook("message_sending", reply, { ...outbound, runId: undefined }), undefined);
  assert.equal(hook("message_sending", reply, { ...outbound, runId: "owner-dm-run" }), undefined);
});

test("a late agent_end from an older run cannot clear the current run's silence", async () => {
  const hook = fixture();
  const current = { ...turn, runId: "turn-two" };
  await hook("before_prompt_build", {}, current);
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, current);
  await hook("agent_end", {}, turn);
  assert.equal(hook("message_sending", { to: "cht_MiXeD", content: "Status" }, { ...outbound, runId: current.runId })?.cancel, true);
});
