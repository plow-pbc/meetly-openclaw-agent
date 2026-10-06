import assert from "node:assert/strict";
import { test } from "node:test";
import { registerGuestTools } from "../plugin/guest-tools.js";
import { createGuestTurns, guestTurns } from "../plugin/guest-turn.js";

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
    guestTurns.beforeTool({ toolName: name, toolCallId: id }, turn);
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
  guestTurns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "pick" }, turn);
  await tools.get("meetly_pick_time").execute("pick", {});
  guestTurns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "ask" }, { ...turn, sessionKey: turn.sessionKey });
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
  guestTurns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "pick" }, turn);
  await tools.get("meetly_pick_time").execute("pick", {});
  context.sessionKey = "group-two";
  guestTurns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "ask" }, { ...turn, sessionKey: turn.sessionKey });
  const result = await tools.get("meetly_ask_owner").execute("ask", { replyMode: "question_only" });
  assert.equal(result.details.silent, true);
  assert.equal(result.details.schedulingResult, undefined);
});

test("guest booking receives the host turn boundary across prompt rebuilds", async t => {
  const turn = { runId: "booking-boundary", sessionKey: "group-booking" };
  let now = Date.parse("2026-10-05T12:00:00Z");
  const startedAt = now;
  t.mock.method(Date, "now", () => now);
  guestTurns.begin(turn);
  t.after(() => guestTurns.end({}, turn));
  const tools = new Map<string, any>();
  let received: any;
  registerGuestTools({ registerTool(factory: any) { const tool = factory({ sessionKey: turn.sessionKey }); tools.set(tool.name, tool); } },
    async (ctx: unknown) => { received = ctx; return { status: "booked" }; });
  now += 60_000;
  guestTurns.begin(turn);
  guestTurns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "book" }, turn);
  await tools.get("meetly_pick_time").execute("book", {});
  assert.equal(received.turnStartedAt, startedAt);
});

for (const action of ["pick", "other_times", "format", "decline"]) test(`successful ${action} explicitly clears an earlier silent handoff`, () => {
  const turn = { sessionKey: "ask-first", runId: action };
  guestTurns.begin(turn);
  guestTurns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "ask" }, turn);
  assert.equal(guestTurns.reply(turn.sessionKey, "ask", "ask_owner", { silent: true }).silent, true);
  guestTurns.beforeTool({ toolName: `meetly_${action}`, toolCallId: "action" }, turn);
  const result = guestTurns.reply(turn.sessionKey, "action", action, { status: action === "pick" ? "booked" : "offered" });
  assert.equal(result.silent, false);
  guestTurns.end({}, turn);
});

test("holding replies are delivered once and make the run terminal",async t=>{
 const turn={runId:"holding",sessionKey:"holding-group"}; guestTurns.begin(turn); t.after(()=>guestTurns.end({},turn));
 const sent:any[]=[]; const tools=new Map<string,any>(); let executed=0;
 registerGuestTools({registerTool(factory:any){const tool=factory({sessionKey:turn.sessionKey,agentAccountId:"chat",nativeChannelId:"group",config:{}});tools.set(tool.name,tool);},runtime:{channel:{routing:{resolveAgentRoute:()=>({agentId:"main",sessionKey:turn.sessionKey})},session:{resolveStorePath:()=>"/sessions",updateLastRoute:async()=>{}}}}},async()=>{executed++;return {guestReply:"I've asked Alex to approve that time.",ownerAskSent:true};},async()=>({buildOutboundSessionContext:()=>({}),sendDurableMessageBatch:async(args:any)=>{sent.push(args);return {status:"sent"};}}));
 guestTurns.beforeTool?.({toolName:"meetly_other_times",toolCallId:"wait"},turn);
 const result=await tools.get("meetly_other_times").execute("wait",{}); assert.equal(result.details.guestReplyDelivered,true); assert.equal(result.details.silent,true); assert.equal(sent.length,1);
 guestTurns.beforeTool?.({toolName:"meetly_pick_time",toolCallId:"later"},turn);
 const next=await tools.get("meetly_pick_time").execute("later",{}); assert.equal(next.details.silent,true); assert.equal(executed,1);
});
const invitationGuidance = [{ invitationUpdated: undefined, expected: true }, { invitationUpdated: true, expected: false }];
for (const row of invitationGuidance) test(`invitation guidance: update=${row.invitationUpdated}`, async () => {
  let pick: any;
  registerGuestTools({ registerTool(factory: any) { const tool = factory({}); if (tool.name === "meetly_pick_time") pick = tool; } },
    async () => ({ status: "booked", invitationSent: false, invitationUpdated: row.invitationUpdated }));
  assert.equal(/no invitation will follow/i.test(JSON.stringify((await pick.execute("pick", {})).content)), row.expected);
});

test("host call bindings isolate overlapping runs in the same session and serialize their actions", async () => {
  const turns = createGuestTurns();
  const first = { runId: "first", sessionKey: "shared" };
  const second = { runId: "second", sessionKey: "shared" };
  turns.begin(first);
  turns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "pick" }, first);
  turns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "question" }, first);
  turns.begin(second);
  turns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "other-run" }, second);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const actions: string[] = [];
  const booking = turns.execute("shared", "pick", async () => {
    actions.push("booking"); await gate; return { status: "booked" };
  });
  const question = turns.execute("shared", "question", async () => {
    actions.push("question"); return { silent: true };
  });
  await Promise.resolve();
  assert.deepEqual(actions, ["booking"]);
  release();
  const booked = await booking;
  turns.reply("shared", "pick", "pick", booked);
  const handoff = turns.reply("shared", "question", "ask_owner", await question);
  assert.equal(handoff.schedulingResult.status, "booked");
  assert.deepEqual(actions, ["booking", "question"]);
  assert.equal(turns.reply("shared", "other-run", "ask_owner", { silent: true }).schedulingResult, undefined);
  turns.end({}, first); turns.end({}, second);
});

test("a mixed question before a failed scheduling action does not silence its failure", async t => {
  const turn = { runId: "ask-first-mixed", sessionKey: "mixed" };
  guestTurns.begin(turn); t.after(() => guestTurns.end({}, turn));
  const tools = new Map<string, any>();
  registerGuestTools({ registerTool(factory: any) { const tool = factory({ sessionKey: turn.sessionKey }); tools.set(tool.name, tool); } },
    async (_ctx: unknown, action: string) => action === "ask_owner" ? { silent: true } : { error: "Unavailable" });
  guestTurns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "ask" }, turn);
  const ask = await tools.get("meetly_ask_owner").execute("ask", { replyMode: "with_scheduling" });
  assert.equal(ask.details.silent, false);
  guestTurns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "pick" }, turn);
  const pick = await tools.get("meetly_pick_time").execute("pick", {});
  assert.equal(pick.details.recovery.action, "reply");
});

test("a delivered holding reply cannot revive an earlier scheduling final", async () => {
  const turns = createGuestTurns(), turn = { runId: "book-then-wait", sessionKey: "group" };
  turns.begin(turn);
  turns.beforeTool({ toolName: "meetly_pick_time", toolCallId: "book" }, turn);
  turns.reply("group", "book", "pick", { status: "booked" });
  turns.beforeTool({ toolName: "meetly_other_times", toolCallId: "wait" }, turn);
  const wait = await turns.execute("group", "wait", async () => ({ guestReplyAttempted: true, guestReplyDelivered: true, silent: true }));
  turns.reply("group", "wait", "other_times", wait);
  turns.beforeTool({ toolName: "meetly_ask_owner", toolCallId: "ask" }, turn);
  const next = await turns.execute("group", "ask", async () => { throw new Error("terminal run must not execute"); });
  const reply = turns.reply("group", "ask", "ask_owner", next);
  assert.equal(reply.silent, true);
  assert.equal(reply.schedulingResult, undefined);
  turns.end({}, turn);
});
