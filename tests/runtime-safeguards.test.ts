import { test } from "node:test";
import assert from "node:assert/strict";
import gate from "../plugin/index.js";
import { spawnSync } from "node:child_process";

function hooks() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  gate.register({ registerTool() {}, on(name: string, fn: any) { handlers[name] = fn; }, logger: { info() {} } });
  return handlers;
}

test("system sends name missing arguments; owner DM sends retain their implicit destination", () => {
  const before = hooks().before_tool_call!;
  const incomplete = before({ toolName: "message", params: { action: "send" } }, {});
  assert.equal(incomplete?.block, true);
  assert.match(incomplete.blockReason, /no target .* and no message/);
  const owner = { requester: { channel: "plow", senderId: "plow-owner" }, sessionKey: "agent:main:main" };
  assert.equal(before({ toolName: "message", params: { action: "send", message: "May I overlap this?" } }, owner), undefined);
  const empty = before({ toolName: "message", params: { action: "send", message: " " } }, owner);
  assert.equal(empty?.block, true);
  assert.match(empty.blockReason, /no message/);
  assert.doesNotMatch(empty.blockReason, /no target/);
  for (const params of [{ action: "send", target: "cht_fixture", message: "Hello" },
    { action: "send", targets: ["cht_fixture"], message: "Hello" }, { action: "read" }]) {
    assert.equal(before({ toolName: "message", params }, {}), undefined);
  }
  assert.equal(before({ toolName: "exec", params: {} }, {}), undefined);
});

test("error replies are rewritten as a plain failure while ordinary replies pass", () => {
  const sending = hooks().reply_payload_sending;
  assert.equal(typeof sending, "function");
  const payload = { text: "⚠️ Meetly Movable failed: Request timed out", isError: true, replyToId: "msg_fixture" };
  assert.deepEqual(sending!({ kind: "final", runId: "failed", payload }), { payload: {
    ...payload, text: "Sorry, I couldn't finish that just now. Please send it again in a moment.", isError: false,
  } });
  assert.equal(sending!({ kind: "final", payload: { text: "Booked." } }), undefined);
});

test("registered lifecycle hooks cancel a synthesized final after a silent run", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "openclaw/plugin-sdk/reply-runtime") return {
        url: "data:text/javascript," + encodeURIComponent('export const isSilentReplyText = text => text.trim() === "NO_REPLY";'), shortCircuit: true,
      };
      return next(specifier, context);
    } });
    const { default: gate } = await import(${JSON.stringify(new URL("../plugin/index.js", import.meta.url).href)});
    await new Promise(resolve => setImmediate(resolve));
    const hooks = {};
    gate.register({ registerTool() {}, on(name, fn) { hooks[name] = fn; }, logger: { info() {} } });
    const ctx = { sessionKey: "agent:main:main", runId: "silent-fixture" };
    hooks.agent_end({ runId: ctx.runId, messages: [{ role: "assistant", content: "NO_REPLY" }] }, ctx);
    console.log(JSON.stringify(hooks.reply_payload_sending?.({ kind: "final", runId: ctx.runId,
      payload: { text: "The tool run finished, but no final summary was produced." } }) ?? null));
  `], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cancel: true, reason: "the run ended on the silent reply" });
});
