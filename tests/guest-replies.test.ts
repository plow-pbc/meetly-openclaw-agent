import assert from "node:assert/strict";
import { test } from "node:test";
import { registerGuestTools } from "../plugin/guest-tools.js";
import { guestTurns } from "../plugin/guest-turn.js";

for (const failedAsk of [false, true]) test(`a question handoff preserves an earlier booking confirmation: failedAsk=${failedAsk}`, async t => {
  const turn = { runId: `mixed-${failedAsk}`, sessionKey: "group-one" };
  const context = { sessionKey: turn.sessionKey, agentAccountId: "chat" };
  const booked = { status: "booked", booked: { start: "2026-10-12T10:00:00Z" }, format: "phone" };
  const tools = new Map<string, any>();
  registerGuestTools({ registerTool(factory: any) { const tool = factory(context); tools.set(tool.name, tool); } },
    async (_ctx: unknown, action: string) => action === "pick" ? booked : { silent: true, ...(failedAsk ? { error: "Owner delivery unknown" } : { ownerAskSent: true }) });
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  const call = async (name: string, id: string) => {
    guestTurns.beforeTool({ toolName: name }, { ...turn, toolCallId: id });
    return tools.get(name).execute(id, {});
  };
  await call("meetly_pick_time", "pick");
  guestTurns.begin(turn);
  const ask = await call("meetly_ask_owner", "ask");
  assert.equal(ask.details.silent, false);
  assert.deepEqual(ask.details.schedulingResult, booked);
  assert.notEqual(ask.details.recovery?.action, "silent");
  // A later question-only turn must not repeat this turn's confirmation.
  guestTurns.end({}, turn);
  guestTurns.begin(turn);
  const later = await call("meetly_ask_owner", "later");
  assert.equal(later.details.silent, true);
  assert.equal(later.details.schedulingResult, undefined);
});

test("failed picks cannot supply a booking confirmation", async t => {
  const turn = { runId: "failed-pick", sessionKey: "group-one" };
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  const tools = new Map<string, any>();
  registerGuestTools({ registerTool(factory: any) { const tool = factory({ sessionKey: turn.sessionKey }); tools.set(tool.name, tool); } },
    async (_ctx: unknown, action: string) => action === "pick" ? { error: "Unavailable" } : { silent: true });
  guestTurns.beforeTool({ toolName: "meetly_pick_time" }, { ...turn, toolCallId: "pick" });
  await tools.get("meetly_pick_time").execute("pick", {});
  guestTurns.beforeTool({ toolName: "meetly_ask_owner" }, { ...turn, toolCallId: "ask" });
  const result = await tools.get("meetly_ask_owner").execute("ask", {});
  assert.equal(result.details.silent, true);
  assert.equal(result.details.schedulingResult, undefined);
});

test("a booking confirmation cannot cross sessions", async t => {
  const turn = { runId: "session-boundary", sessionKey: "group-one" };
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  const tools = new Map<string, any>();
  const context = { sessionKey: turn.sessionKey };
  registerGuestTools({ registerTool(factory: any) { const tool = factory(context); tools.set(tool.name, tool); } },
    async (_ctx: unknown, action: string) => action === "pick" ? { status: "booked" } : { silent: true });
  guestTurns.beforeTool({ toolName: "meetly_pick_time" }, { ...turn, toolCallId: "pick" });
  await tools.get("meetly_pick_time").execute("pick", {});
  guestTurns.beforeTool({ toolName: "meetly_ask_owner" }, { ...turn, toolCallId: "ask" });
  context.sessionKey = "group-two";
  const result = await tools.get("meetly_ask_owner").execute("ask", {});
  assert.equal(result.details.silent, true);
  assert.equal(result.details.schedulingResult, undefined);
});
