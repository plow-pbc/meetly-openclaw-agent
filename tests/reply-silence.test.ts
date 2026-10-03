import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../plugin/index.js";
import { sendPlowMessage } from "../plugin/guest-tools.js";

const sessionKey = "agent:main:plow:group:cht_mixed";
const turn = { channel: "plow", accountId: "chat", chatId: "cht_MiXeD", sessionKey, runId: "turn-one" };
const outbound = { channelId: "plow", accountId: "chat", conversationId: "cht_MiXeD", sessionKey };
const reply = { to: "cht_MiXeD", content: "I have asked Patrick." };
function fixture() {
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  plugin.register({ registerTool() {}, on(name: string, handler: (event: any, ctx: any) => any) { hooks.set(name, handler); } });
  hooks.get("session_end")?.({}, { sessionKey });
  return (name: string, event: object, ctx: object) => hooks.get(name)?.(event, ctx);
}

for (const toolName of ["meetly_ask_owner", "meetly_answer_owner"]) test(`${toolName} cancels group sends without requiring an outbound run id`, async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  await hook("after_tool_call", { toolName, result: { details: { silent: true } } }, turn);
  for (const content of ["I've asked Patrick.", "I'll get back to you."]) {
    assert.equal(hook("message_sending", { ...reply, content }, outbound)?.cancel, true);
  }
  assert.equal(hook("message_sending", reply, { ...outbound, sessionKey: "agent:main:main" })?.cancel, true);
  assert.equal(hook("message_sending", { ...reply, to: "plow:cht_MiXeD" }, outbound)?.cancel, true);
  for (const to of ["plow-owner", "cht_other"]) assert.equal(hook("message_sending", { ...reply, to }, outbound), undefined);
  assert.equal(hook("message_sending", reply, { ...outbound, channelId: "other" }), undefined);
  assert.equal(hook("message_sending", reply, { ...outbound, accountId: "email" }), undefined);
  await hook("before_prompt_build", {}, turn);
  assert.equal(hook("message_sending", reply, outbound)?.cancel, true);
  await hook("before_prompt_build", {}, { ...turn, runId: "turn-two" });
  await hook("after_tool_call", { toolName, result: { details: { silent: true } } }, turn);
  assert.equal(hook("message_sending", reply, outbound), undefined);
});

test("only a Meetly tool's boolean silent result suppresses group sends", async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  for (const event of [
    { toolName: "other_tool", result: { details: { silent: true } } },
    { toolName: "meetly_view_request", result: { details: { silent: "true" } } },
    { toolName: "meetly_view_request", result: { content: [{ type: "text", text: '{"silent":true}' }] } },
  ]) {
    await hook("after_tool_call", event, turn);
    assert.equal(hook("message_sending", reply, outbound), undefined);
  }
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { isError: true, details: { silent: true } } }, turn);
  assert.equal(hook("message_sending", reply, outbound)?.cancel, true);
  await hook("session_end", {}, { sessionKey });
  assert.equal(hook("message_sending", reply, outbound), undefined);
});

test("agent_end clears silence, but an older run cannot clear the current run", async () => {
  const hook = fixture();
  const current = { ...turn, runId: "turn-two" };
  await hook("before_prompt_build", {}, current);
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, current);
  await hook("agent_end", {}, turn);
  assert.equal(hook("message_sending", reply, outbound)?.cancel, true);
  await hook("agent_end", {}, current);
  assert.equal(hook("message_sending", reply, outbound), undefined);
});

test("Meetly's own send bypass is scoped to that asynchronous send and unwinds on failure", async () => {
  const hook = fixture();
  await hook("before_prompt_build", {}, turn);
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, turn);
  const api = { runtime: { channel: {
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey }) },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} },
  } } };
  for (const fail of [false, true]) {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const send = sendPlowMessage(api, { config: {} }, reply.to, reply.content, "group", async () => ({
      buildOutboundSessionContext: (input: any) => input,
      sendDurableMessageBatch: async () => {
        await waiting;
        assert.equal(hook("message_sending", reply, outbound), undefined);
        if (fail) throw new Error("transport failed");
        return { status: "sent" };
      },
    }));
    assert.equal(hook("message_sending", reply, outbound)?.cancel, true);
    release();
    if (fail) await assert.rejects(send, /transport failed/); else await send;
    assert.equal(hook("message_sending", reply, outbound)?.cancel, true);
  }
});

test("agent_end releases the group but still suppresses that run's late final payload", async () => {
  const hook = fixture();
  const payload = { payload: { text: reply.content }, channel: "plow", sessionKey, runId: turn.runId };
  await hook("before_prompt_build", {}, turn);
  await hook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, turn);
  await hook("agent_end", {}, turn);
  assert.equal(hook("message_sending", reply, outbound), undefined);
  assert.equal(hook("reply_payload_sending", payload, outbound)?.cancel, true);
  assert.equal(hook("reply_payload_sending", { ...payload, runId: "owner-dm-run" }, outbound), undefined);
  assert.equal(hook("reply_payload_sending", { ...payload, runId: undefined }, outbound), undefined);
  assert.equal(hook("reply_payload_sending", payload, { ...outbound, accountId: "email" }), undefined);
  await hook("before_prompt_build", {}, { ...turn, runId: "turn-two" });
  assert.equal(hook("reply_payload_sending", payload, outbound), undefined);
});

test("agent and outbound plugin registrations share the silent turn and its late final", async () => {
  const agentHook = fixture();
  const outboundHook = fixture();
  await agentHook("before_prompt_build", {}, turn);
  await agentHook("after_tool_call", { toolName: "meetly_ask_owner", result: { details: { silent: true } } }, turn);
  assert.equal(outboundHook("message_sending", reply, outbound)?.cancel, true);
  await agentHook("agent_end", {}, turn);
  assert.equal(outboundHook("message_sending", reply, outbound), undefined);
  assert.equal(outboundHook("reply_payload_sending", { channel: "plow", sessionKey, runId: turn.runId }, outbound)?.cancel, true);
});
