import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { answerOwner } from "../skills/meetly/scripts/answer-owner.ts";
import { calendarAction } from "../skills/meetly/scripts/calendar.ts";
import { recordBooking } from "../skills/meetly/scripts/record-booking.ts";
import { guestAction } from "../skills/meetly/scripts/guest.ts";
import { registerOwnerTools } from "../plugin/owner-tools.js";
import { addRequest, updateRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, cli, fakeCalendar, tmpHome } from "./helpers.ts";

const ctx = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "plow-owner",
  sessionKey: "agent:main:main", nativeChannelId: "owner-dm", config: {} };
const args = { outcome: "answer" as const, requestId: "mia", askedAt: "2026-10-03T16:00:00Z", text: "Patrick says, please bring the Q3 budget numbers." };
const timeApproval = { askedAt: args.askedAt, start: "2026-10-05T20:00:00Z", end: "2026-10-05T20:30:00Z" };

function fixture(t: TestContext) {
  const home = tmpHome();
  const previous = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const path = join(home, "ledger.json");
  let ledger: Ledger = { requests: [] };
  for (const name of ["mia", "lev"]) {
    ledger = addRequest(ledger, { origin: "owner", name, handle: `${name}@example.com`, topic: "Call", chatUid: `group-${name}`,
      durationMin: 30, offered: [{ start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", account: "owner@example.com" }] }, Date.now(), name);
    ledger = updateRequest(ledger, name, { pendingOwner: { question: "Should I bring the budget numbers?", askedAt: args.askedAt } }, Date.now());
  }
  writeJson(path, ledger);
  writeJson(join(home, "config.json"), { ...DEFAULTS, ownerName: "Patrick", timezone: "UTC", defaultAccount: "owner@example.com",
    calendars: [{ account: "owner@example.com", id: "primary" }], setupDoneAt: args.askedAt });
  return { path, ledger, read: () => readJson<Ledger>(path, { requests: [] }) };
}

function ownerTool(sendDurableMessageBatch: (input: any) => Promise<any>, context = ctx) {
  let tool: any;
  const route = { agentId: "main", sessionKey: "agent:main:plow:group:group-mia" };
  registerOwnerTools({ registerTool(factory: any) { tool = factory(context); }, runtime: { channel: {
    routing: { resolveAgentRoute(input: any) {
      assert.deepEqual(input.peer, { kind: "group", id: "group-mia" }); return route;
    } },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} },
  } } }, answerOwner, async () => ({
    buildOutboundSessionContext: (input: any) => input, sendDurableMessageBatch,
  }));
  return { tool, route };
}

test("the owner answer sends once to the matched group, clears its question, and permits the next ask", async t => {
  const f = fixture(t);
  f.ledger = updateRequest(f.ledger, "mia", { status: "booked" }, Date.now());
  writeJson(f.path, f.ledger);
  const deliveries: any[] = [];
  const { tool, route } = ownerTool(async input => {
    assert.ok(f.read().requests[0]!.pendingOwner?.answerAttemptedAt, "persist the attempt before delivery");
    deliveries.push(input); return { status: "sent" };
  });
  const result = await tool.execute("answer", { ...args, chatUid: "intruder" });
  assert.equal(result.isError, false);
  assert.equal(result.details.sent, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, "group-mia");
  assert.deepEqual(deliveries[0].payloads, [{ text: args.text }]);
  assert.deepEqual(deliveries[0].mirror, route);
  assert.equal(deliveries[0].session.conversationType, "group");
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.equal(f.read().requests[0]!.status, "booked");
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
  assert.equal((await tool.execute("repeat", args)).isError, true);
  assert.equal(deliveries.length, 1);
  const next = await guestAction({ messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "group-mia", requesterSenderId: "mia@example.com" },
    "ask_owner", { question: "Which quarter?" }, async () => {});
  assert.ok(!("error" in next));
  assert.equal((f.read().requests[0]!.pendingOwner as { question: string }).question, "Which quarter?");
});

test("guests, other channels and other groups cannot answer a pending question", async t => {
  const f = fixture(t);
  for (const context of [{}, { ...ctx, senderIsOwner: false }, { ...ctx, agentAccountId: "email" },
    { ...ctx, messageChannel: "webchat" }, { ...ctx, requesterSenderId: undefined },
    { ...ctx, sessionKey: "group-other", nativeChannelId: "group-other" },
    { ...ctx, sessionKey: "group-mia", nativeChannelId: "group-MIA" },
    { ...ctx, sessionKey: "group-mia", nativeChannelId: "plow:group-mia" }]) {
    assert.ok("error" in await answerOwner(context, args, async () => assert.fail("must not send")));
  }
  for (const invalid of [{ ...args, askedAt: "old" }, { ...args, requestId: "missing" }, { ...args, text: " " }]) {
    assert.ok("error" in await answerOwner(ctx, invalid, async () => assert.fail("must not send")));
  }
  assert.deepEqual(f.read(), f.ledger);
});

for (const booked of [false, true]) for (const inGroup of [false, true]) test(`time approval answer sends once and clears after delivery: booked=${booked}, inGroup=${inGroup}`, async t => {
  const f = fixture(t);
  f.ledger = updateRequest(f.ledger, "mia", { pendingOwner: timeApproval }, Date.now());
  if (booked) f.ledger = recordBooking(f.ledger, "mia", { id: "event", status: "confirmed", meetUrl: null, start: timeApproval.start, end: timeApproval.end }, "owner@example.com", Date.now()).ledger;
  writeJson(f.path, f.ledger);
  const context = inGroup ? { ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" } : ctx;
  const answer = { ...args, text: booked ? "Booked for Monday at 8pm." : "That time doesn't work for Patrick." };
  let sends = 0;
  const send = async (to: string, text: string) => {
    sends++;
    assert.equal(to, "group-mia");
    assert.equal(text, answer.text);
    assert.ok(f.read().requests[0]!.pendingOwner?.answerAttemptedAt);
    assert.ok("error" in await answerOwner(context, answer, async () => assert.fail("concurrent resend")));
  };
  assert.deepEqual(await answerOwner(context, answer, send), { answered: true, sent: true, requestId: "mia", ...(inGroup ? { silent: true } : {}) });
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
  assert.ok("error" in await answerOwner(context, answer, send));
  assert.equal(sends, 1);
});

for (const kind of ["question", "denied", "booked"]) for (const status of ["queued", "throw"]) test(`${kind} answer delivery ${status} requires a durable clear before another attempt`, async t => {
  const f = fixture(t);
  const calendar = fakeCalendar([]);
  if (kind !== "question") writeJson(f.path, updateRequest(f.ledger, "mia", { pendingOwner: timeApproval }, Date.now()));
  if (kind === "booked") await calendarAction("mia", { action: "book", start: timeApproval.start, end: timeApproval.end }, { command: calendar.command });
  const before = f.read().requests[0]!;
  const calls = [...calendar.calls];
  const answer = { ...args, text: kind === "booked" ? "Booked for Monday at 8pm." : kind === "denied" ? "That time doesn't work for Patrick." : args.text };
  let outcome = status;
  let sends = 0;
  const { tool } = ownerTool(async () => {
    sends++;
    assert.ok(f.read().requests[0]!.pendingOwner?.answerAttemptedAt);
    if (outcome === "throw") throw new Error("PRIVATE TRANSPORT ERROR");
    return { status: outcome };
  });
  const result = await tool.execute("answer", answer);
  assert.match(result.content[0].text, /delivery is unknown/);
  assert.doesNotMatch(result.content[0].text, /PRIVATE/);
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
  const retry = await tool.execute("retry", answer);
  assert.match(retry.content[0].text, /already attempted/);
  assert.equal(sends, 1);
  const reloaded = await import(new URL(`../skills/meetly/scripts/answer-owner.ts?restart=${kind}-${status}`, import.meta.url).href);
  assert.ok("error" in await reloaded.answerOwner(ctx, answer, async () => assert.fail("must not resend after reload")));
  assert.ok(f.read().requests[0]!.pendingOwner);
  const pending = cli("ledger.ts", ["pending"], { MEETLY_HOME: process.env.MEETLY_HOME! });
  assert.ok(pending.json.requests.some((r: { id: string }) => r.id === "mia"));
  const clear = cli("ledger.ts", ["delivery", "--id", "mia", "--kind", "answer", "--action", "clear"], { MEETLY_HOME: process.env.MEETLY_HOME! });
  assert.equal(clear.status, 0, clear.stderr);
  assert.deepEqual(clear.json.request.pendingOwner, before.pendingOwner);
  outcome = "sent";
  assert.equal((await tool.execute("authorized-retry", answer)).isError, false);
  assert.equal(sends, 2);
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.deepEqual(f.read().requests[0]!.booked, before.booked);
  assert.equal(f.read().requests[0]!.calendarRevision, before.calendarRevision);
  assert.deepEqual(calendar.calls, calls, "retry only delivers the result, without calendar work");
});

test("an owner answer already visible in the group clears the question without sending it again", async t => {
  const f = fixture(t);
  const result = await answerOwner({ ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" }, args,
    async () => assert.fail("the owner's answer is already in the group"));
  assert.deepEqual(result, { answered: true, sent: false, requestId: "mia", silent: true });
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
});

test("concurrent sends and stale clears cannot consume another question", async t => {
  const f = fixture(t);
  const newer = { question: "Which entrance?", askedAt: "2026-10-03T17:00:00Z" };
  const result = await answerOwner(ctx, args, async () => {
    assert.ok("error" in await answerOwner(ctx, args, async () => assert.fail("concurrent send")));
    writeJson(f.path, updateRequest(f.read(), "mia", { pendingOwner: newer }, Date.now()));
  });
  assert.ok("sent" in result);
  assert.deepEqual(f.read().requests[0]!.pendingOwner, newer);
});

test("an applied calendar change is delivered in the group before its question clears", async t => {
  const f = fixture(t);
  let sends = 0;
  const result = await answerOwner({ ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" },
    { ...args, outcome: "calendar_change", text: "Updated the meeting to the library." }, async (to, text) => {
      sends++;
      assert.equal(to, "group-mia");
      assert.match(text, /library/);
      assert.ok(f.read().requests[0]!.pendingOwner);
    });
  assert.equal(sends, 1);
  assert.deepEqual(result, { answered: true, sent: true, requestId: "mia", silent: true });
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
});

test("an answer needs an explicit outcome before clearing or sending", async t => {
  const f = fixture(t);
  let sends = 0;
  for (const outcome of [undefined, "guess", "decline_alternatives"]) {
    const result = await answerOwner(ctx, { ...args, outcome } as any, async () => { sends++; });
    assert.equal(sends, 0);
    assert.ok("error" in result);
    assert.ok(f.read().requests[0]!.pendingOwner);
  }
});

function alternativesFixture(t: TestContext, mixed = false) {
  const f = fixture(t);
  t.mock.method(Date, "now", () => Date.parse("2026-10-03T08:00:00Z"));
  const previousToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "fixture";
  t.after(() => { if (previousToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN; else process.env.PLOW_MCP_BRIDGE_TOKEN = previousToken; });
  const request = f.ledger.requests[0]!;
  request.constraints = { from: "2026-10-05", to: "2026-10-05", days: ["mon"], after: "10:00", before: "11:30" };
  request.excludedDays = ["tue"]; request.format = "phone";
  request.offered[0]!.holdId = "old";
  if (mixed) request.offered.push({ ...request.offered[0]!, start: "2026-10-05T10:30:00Z", end: "2026-10-05T11:00:00Z", holdId: "fresh" });
  const pendingOwner = { question: "May I check for other times again?", askedAt: args.askedAt,
    alternatives: { previousStarts: ["2026-10-05T12:00:00+02:00"] } };
  f.ledger = updateRequest(f.ledger, "mia", { pendingOwner }, Date.now());
  writeJson(f.path, f.ledger);
  const cal = fakeCalendar(request.offered.map(o => calendarEvent(o.holdId!, o.start, o.end)));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body));
    assert.equal(call.params.name, "plow_run_command");
    const result = await cal.command({ argv: call.params.arguments.argv });
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: result.output }) }] } });
  });
  return { ...f, cal, request, pendingOwner };
}

for (const inGroup of [false, true]) for (const mixed of [false, true])
test(`exhausted-search owner tool searches, holds and delivers without rejected starts: group=${inGroup}, mixed=${mixed}`, async t => {
  const f = alternativesFixture(t, mixed);
  const context = inGroup ? { ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" } : ctx;
  const deliveries: any[] = [];
  const { tool } = ownerTool(async input => {
    const saved = f.read().requests[0]!;
    assert.ok(saved.pendingOwner?.answerAttemptedAt);
    assert.ok(saved.offered.every(o => o.holdId && Date.parse(o.start) !== Date.parse(f.pendingOwner.alternatives.previousStarts[0]!)));
    assert.ok(f.cal.calls.some(c => c[2] === "create"), "holds must precede delivery");
    deliveries.push(input); return { status: "sent" };
  }, context);
  const result = await tool.execute("approve", { ...args, text: "Yes" });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].payloads[0].text, /10:30|11:00/);
  assert.doesNotMatch(deliveries[0].payloads[0].text, /10:00|Yes|previousStarts/);
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.deepEqual(f.read().requests[0]!.constraints, f.request.constraints);
  assert.deepEqual(f.read().requests[0]!.excludedDays, ["tue"]);
  assert.equal(f.read().requests[0]!.durationMin, 30);
  assert.equal((await tool.execute("again", args)).isError, true);
  assert.equal(deliveries.length, 1);
});

test("exhausted-search approval cannot reserve a question replaced during its calendar write", async t => {
  const f = alternativesFixture(t);
  const fetch = globalThis.fetch;
  let replacement: unknown;
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) => {
    if (!replacement && JSON.parse(String(init.body)).params.arguments.argv[2] === "create") {
      const refusal = await answerOwner({ ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" },
        { ...args, outcome: "decline_alternatives" }, async () => assert.fail("refusal is already visible"));
      assert.equal("error" in refusal, false);
      await guestAction({ messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "group-mia", requesterSenderId: "mia@example.com" },
        "ask_owner", { question: "Which entrance?" }, async () => {});
      replacement = f.read().requests[0]!.pendingOwner;
      assert.ok(replacement);
    }
    return fetch(url, init);
  });
  let sends = 0;
  const { tool } = ownerTool(async () => { sends++; return { status: "sent" }; });
  const result = await tool.execute("approve", { ...args, text: "Yes" });
  assert.equal(result.isError, true);
  assert.equal(sends, 0);
  assert.deepEqual(f.read().requests[0]!.pendingOwner, replacement);
  assert.ok(f.read().requests[0]!.offered.every(o => o.holdId));
});

for (const [locale, expected] of [
  ["pt-BR", /^Patrick tem disponibilidade .+ ou .+\. Qual horário funciona para você\?$/],
  ["pt-PT", /^Patrick tem disponibilidade .+ ou .+\. Qual horário funciona para você\?$/],
  ["fr-FR", /^Patrick: .+ ou .+\?$/],
] as const) test(`exhausted-search offer uses the saved guest locale: ${locale}`, async t => {
  const f = alternativesFixture(t);
  writeJson(f.path, updateRequest(f.read(), "mia", { locale }, Date.now()));
  const deliveries: string[] = [];
  const { tool } = ownerTool(async input => { deliveries.push(input.payloads[0].text); return { status: "sent" }; });
  const result = await tool.execute("approve", { ...args, text: "Yes" });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]!, expected);
  assert.doesNotMatch(deliveries[0]!, / is free | or |Which time/);
  t.diagnostic(deliveries[0]!);
});

for (const outcome of ["empty", "calendar-failure", "hold-failure", "delivery-unknown"])
test(`exhausted-search transaction retains pending on ${outcome}`, async t => {
  const f = alternativesFixture(t);
  if (outcome === "empty") f.cal.events.set("busy", calendarEvent("busy", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"));
  if (outcome === "calendar-failure") t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  if (outcome === "hold-failure") {
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit) =>
      JSON.parse(String(init.body)).params.arguments.argv[2] === "create" ? new Response("", { status: 503 }) : fetch(url, init));
  }
  let sends = 0;
  const { tool } = ownerTool(async () => { sends++; return { status: "unknown" }; });
  const result = await tool.execute("approve", { ...args, text: "Yes" });
  assert.equal(result.isError, true);
  assert.ok(f.read().requests[0]!.pendingOwner);
  assert.equal(sends, outcome === "delivery-unknown" ? 1 : 0);
  if (outcome === "delivery-unknown") {
    const calls = [...f.cal.calls];
    assert.equal((await tool.execute("again", args)).isError, true);
    assert.equal(sends, 1); assert.deepEqual(f.cal.calls, calls, "unknown delivery cannot repeat the transaction");
  } else {
    assert.deepEqual(f.read().requests[0]!.offered, f.request.offered);
    assert.ok(f.cal.calls.every(c => c[2] === "events"));
  }
});

for (const decline of [false, true]) test(`exhausted-search owner decision applies only explicit changes: decline=${decline}`, async t => {
  const f = alternativesFixture(t);
  const deliveries: string[] = [];
  const { tool } = ownerTool(async input => { deliveries.push(input.payloads[0].text); return { status: "sent" }; });
  const result = await tool.execute("decision", { ...args, text: "Patrick cannot offer another time.", outcome: decline ? "decline_alternatives" : "answer",
    constraints: { from: "2026-10-07", to: "2026-10-07", days: ["wed"] } });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.equal(deliveries.length, 1);
  if (decline) {
    assert.deepEqual(f.read().requests[0]!.offered, f.request.offered);
    assert.deepEqual(f.cal.calls, []);
    assert.equal(deliveries[0], "Patrick cannot offer another time.");
  } else {
    assert.ok(f.read().requests[0]!.offered.every(o => o.start.startsWith("2026-10-07")));
    assert.deepEqual(f.read().requests[0]!.constraints, { ...f.request.constraints, from: "2026-10-07", to: "2026-10-07", days: ["wed"] });
    assert.match(deliveries[0]!, /10:00|10:30|11:00/);
    assert.doesNotMatch(deliveries[0]!, /cannot offer/);
  }
});

for (const inGroup of [false, true]) test(`decline alternatives is an exclusive owner outcome: inGroup=${inGroup}`, async t => {
  const f = fixture(t);
  const context = inGroup ? { ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" } : ctx;
  const pendingOwner = { question: "May I search again?", askedAt: args.askedAt, alternatives: { previousStarts: f.ledger.requests[0]!.offered.map(o => o.start) } };
  writeJson(f.path, updateRequest(f.ledger, "mia", { pendingOwner }, Date.now()));
  const sends: string[] = [];
  const result = await answerOwner(context, { ...args, outcome: "decline_alternatives", text: "Keep the current times." },
    async (_to, text) => { sends.push(text); });
  assert.equal("error" in result, false, JSON.stringify(result));
  assert.equal(sends.length, inGroup ? 0 : 1);
  assert.equal(f.read().requests[0]!.pendingOwner, undefined);
  assert.deepEqual(f.read().requests[0]!.offered, f.ledger.requests[0]!.offered);
});

for (const inGroup of [false, true]) test(`booked exhausted-search approval holds replacements without moving the event: group=${inGroup}`, async t => {
  const f = alternativesFixture(t);
  const booked = { start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z", account: "owner@example.com" };
  f.cal.events.set("booked", calendarEvent("booked", booked.start, booked.end));
  writeJson(f.path, updateRequest(f.read(), "mia", { status: "booked", booked, eventId: "booked", bookedReplacement: true }, Date.now()));
  const deliveries: string[] = [];
  const result = await answerOwner(inGroup ? { ...ctx, sessionKey: "group-mia", nativeChannelId: "group-mia" } : ctx,
    { ...args, outcome: "calendar_change", text: "Yes" }, async (_to, text) => { deliveries.push(text); });
  assert.ok(!("error" in result), JSON.stringify(result));
  const saved = f.read().requests[0]!;
  assert.equal(saved.status, "booked");
  assert.deepEqual(saved.booked, booked);
  assert.equal(saved.bookedReplacement, true);
  assert.ok(saved.offered.some(o => Date.parse(o.start) === Date.parse("2026-10-05T10:30:00Z")));
  assert.equal(saved.pendingOwner, undefined);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]!, /10:30/);
  assert.ok(f.cal.calls.every(c => c[2] !== "update" && !(c[2] === "delete" && c[4] === "booked")));
});
