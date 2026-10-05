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
    return tools.get(name).execute(id, { replyMode: "question_only" });
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
  const result = await tools.get("meetly_ask_owner").execute("ask", { replyMode: "question_only" });
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
  const result = await tools.get("meetly_ask_owner").execute("ask", { replyMode: "question_only" });
  assert.equal(result.details.silent, true);
  assert.equal(result.details.schedulingResult, undefined);
});

for (const order of ["ask-first", "parallel"] as const) test(`mixed questions cannot latch channel silence before a booking: ${order}`, async t => {
  const turn = { runId: order, sessionKey: "mixed-group" };
  const tools = new Map<string, any>();
  const active: string[] = [];
  registerGuestTools({ registerTool(factory: any) { const tool = factory({ sessionKey: turn.sessionKey, agentAccountId: "chat" }); tools.set(tool.name, tool); } },
    async (_ctx: unknown, action: string) => {
      active.push(action);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(active.length, 1, "guest writes must not race over one ledger request");
      active.pop();
      return action === "pick" ? { status: "booked", invitationSent: false } : { silent: true, ownerAskSent: true };
    });
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  let channelSilent = false;
  const call = async (name: string) => {
    guestTurns.beforeTool({ toolName: name }, { ...turn, toolCallId: name });
    const result = await tools.get(name).execute(name, { replyMode: "with_scheduling", question: "Should I bring anything?" });
    // Plow latches any silent result until this run ends.
    channelSilent ||= result.details?.silent === true;
    return result;
  };
  if (order === "parallel") await Promise.all([call("meetly_pick_time"), call("meetly_ask_owner")]);
  else { await call("meetly_ask_owner"); await call("meetly_pick_time"); }
  assert.equal(channelSilent, false, "the successful booking's final reply must be deliverable");
});

for (const replyMode of [undefined, "guess"]) test(`question reply scope must be explicit: ${replyMode}`, async () => {
  let calls = 0, ask: any;
  registerGuestTools({ registerTool(factory: any) { const tool = factory({}); if (tool.name === "meetly_ask_owner") ask = tool; } },
    async () => { calls++; return { silent: true }; });
  const result = await ask.execute("ask", { question: "What to bring?", replyMode });
  assert.equal(calls, 0);
  assert.equal(result.isError, true);
});

for (const delivered of [true, false]) test(`a scheduling wait reply is delivered by the tool before channel silence: delivered=${delivered}`, async () => {
  const sent: any[] = [];
  let tool: any;
  const context = { config: {}, messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "guest-group" };
  registerGuestTools({ registerTool(factory: any) { const candidate = factory(context); if (candidate.name === "meetly_other_times") tool = candidate; },
    runtime: { channel: { routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "group" }) },
      session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} } } } },
    async () => ({ code: "NO_ALTERNATIVES", error: "No alternatives", guestReply: "I'm waiting for Alex's decision about another time.", recovery: { action: "wait", retry: false } }),
    async () => ({ buildOutboundSessionContext: (args: any) => args, sendDurableMessageBatch: async (args: any) => {
      sent.push(args); return { status: delivered ? "sent" : "unknown" };
    } }));
  const result = await tool.execute("waiting", { offer_week: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "guest-group");
  assert.equal(sent[0].payloads[0].text, "I'm waiting for Alex's decision about another time.");
  assert.equal(result.details.silent === true, delivered);
  if (!delivered) assert.match(result.details.error, /delivery.*unconfirmed/i);
});

test("a delivered scheduling wait ends mutations and replies for that run, including queued calls", async t => {
  const turn = { runId: "terminal-wait", sessionKey: "waiting-group" };
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  for (const id of ["wait", "decline"]) guestTurns.beforeTool({ toolName: id === "wait" ? "meetly_other_times" : "meetly_decline" }, { ...turn, toolCallId: id });
  let mutations = 0;
  const held = { silent: true, guestReplyDelivered: true };
  const wait = guestTurns.execute(turn.sessionKey, "wait", async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return held;
  });
  const decline = guestTurns.execute(turn.sessionKey, "decline", async () => { mutations++; return { status: "dropped" }; });
  assert.deepEqual(await wait, held);
  assert.deepEqual(await decline, held);
  assert.equal(mutations, 0);
});
