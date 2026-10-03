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
import { cli, fakeCalendar, tmpHome } from "./helpers.ts";

const ctx = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "plow-owner",
  sessionKey: "agent:main:main", nativeChannelId: "owner-dm", config: {} };
const args = { requestId: "mia", askedAt: "2026-10-03T16:00:00Z", text: "Patrick says, please bring the Q3 budget numbers." };
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

test("the owner answer sends once to the matched group, clears its question, and permits the next ask", async t => {
  const f = fixture(t);
  f.ledger = updateRequest(f.ledger, "mia", { status: "booked" }, Date.now());
  writeJson(f.path, f.ledger);
  const deliveries: any[] = [];
  let tool: any;
  const route = { agentId: "main", sessionKey: "agent:main:plow:group:group-mia" };
  registerOwnerTools({ registerTool(factory: any) { tool = factory(ctx); }, runtime: { channel: {
    routing: { resolveAgentRoute(input: any) {
      assert.deepEqual(input.peer, { kind: "group", id: "group-mia" }); return route;
    } },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} },
  } } }, answerOwner, async () => ({
    buildOutboundSessionContext: (input: any) => input,
    sendDurableMessageBatch: async (input: any) => {
      assert.ok(f.read().requests[0]!.pendingOwner?.answerAttemptedAt, "persist the attempt before delivery");
      deliveries.push(input); return { status: "sent" };
    },
  }));
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
  let tool: any, sends = 0;
  registerOwnerTools({ registerTool(factory: any) { tool = factory(ctx); }, runtime: { channel: {
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "group-mia" }) },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} },
  } } }, answerOwner, async () => ({ buildOutboundSessionContext: (input: any) => input, sendDurableMessageBatch: async () => {
    sends++;
    assert.ok(f.read().requests[0]!.pendingOwner?.answerAttemptedAt);
    if (outcome === "throw") throw new Error("PRIVATE TRANSPORT ERROR");
    return { status: outcome };
  } }));
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
