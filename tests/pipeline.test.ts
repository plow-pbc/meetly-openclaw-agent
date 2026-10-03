import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { registerPipelineHooks } from "../plugin/pipeline.js";
import { addRequest, appendLog, checkContact, doNotContact, recordGuestReply, sameRequest, saveRequest, setDoNotContact, updateRequest, type Ledger, type Request } from "../skills/meetly/scripts/ledger.ts";
import { pipeline, reserveNudges, STALE_OFFER_MS } from "../skills/meetly/scripts/pipeline.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const HOUR = 3_600_000, T0 = Date.parse("2026-10-05T08:00:00Z");
const iso = (time: number) => new Date(time).toISOString();
const empty = (): Ledger => ({ requests: [] });
const offer = { start: "2026-10-08T12:00:00Z", end: "2026-10-08T12:30:00Z", account: "owner@example.com" };
const input = { origin: "owner" as const, handle: "+15551234567", name: "Alex", chatUid: "Chat-A", topic: "Lunch", durationMin: 30, offered: [offer] };
const offered = () => addRequest(empty(), input, T0, "offer");
const request = (ledger: Ledger, id = "offer") => ledger.requests.find(r => r.id === id)!;
function fixture(t: TestContext) {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { MEETLY_HOME: home, PLOW_MCP_BRIDGE_TOKEN: "" }, path: join(home, "ledger.json") };
}
function mixed(now = T0): Ledger {
  let ledger = addRequest(empty(), input, now, "offer");
  ledger = addRequest(ledger, { ...input, handle: "+15557654321", name: "Blair", chatUid: undefined, origin: "inbound", status: "asked", offered: [] }, now, "asked");
  ledger = addRequest(ledger, { ...input, handle: "+15559876543", name: "Casey", chatUid: "Chat-C" }, now, "question");
  return updateRequest(ledger, "question", { pendingOwner: { question: "Should I bring the budget?", askedAt: iso(now) } }, now);
}

test("waiting states are derived; only unanswered offers reach stale at exactly 24 hours", () => {
  const ledger = mixed();
  assert.deepEqual(pipeline(ledger, T0 + STALE_OFFER_MS - 1).map(item => item.reason), ["offer", "owner-decision", "owner-question"]);
  assert.deepEqual(pipeline(ledger, T0 + STALE_OFFER_MS).map(item => item.reason), ["stale-offer", "owner-decision", "owner-question"]);
  const replied = recordGuestReply(ledger, "Chat-A", "+1 (555) 123-4567", T0 + HOUR);
  const state = pipeline(replied, T0 + 25 * HOUR)[0]!;
  assert.equal(state.reason, "offer");
  assert.equal(state.nudge, false);
  assert.match(state.detail, /Guest replied/);
  assert.deepEqual(ledger.requests.map(r => r.status), ["offered", "asked", "offered"]);
});

test("one reserved batch contains stale offers and owner asks, without repeat after time or metadata changes", () => {
  const original = mixed();
  const batch = reserveNudges(original, T0 + 25 * HOUR);
  assert.equal(batch.items.length, 3);
  assert.match(batch.text!, /Alex.*No guest reply/);
  assert.match(batch.text!, /Blair.*Want me to offer times/);
  assert.match(batch.text!, /Casey.*Waiting for your answer/);
  assert.ok(batch.ledger.requests.every(r => r.lastNudge?.at === iso(T0 + 25 * HOUR)));
  assert.equal(reserveNudges(batch.ledger, T0 + 26 * HOUR).text, null);
  const updated = updateRequest(batch.ledger, "offer", { location: "Cafe" }, T0 + 26 * HOUR);
  assert.equal(reserveNudges(updated, T0 + 27 * HOUR).text, null);
  assert.equal(original.requests[0]!.lastNudge, undefined);
  assert.ok(sameRequest(original.requests[0], batch.ledger.requests[0]), "monitor metadata does not invalidate in-flight scheduling snapshots");
});

test("a new offer or owner question gets a new fingerprint; resolved states disappear", () => {
  let ledger = reserveNudges(mixed(), T0 + 25 * HOUR).ledger;
  ledger = updateRequest(ledger, "question", { pendingOwner: null, status: "booked", booked: { ...offer } }, T0 + 26 * HOUR);
  ledger = updateRequest(ledger, "asked", { status: "dropped" }, T0 + 26 * HOUR);
  ledger = saveRequest(ledger, { ...input, offered: [{ ...offer, start: "2026-10-09T12:00:00Z", end: "2026-10-09T12:30:00Z" }] }, T0 + 26 * HOUR, "ignored");
  assert.deepEqual(pipeline(ledger, T0 + 26 * HOUR).map(item => item.id), ["offer"]);
  assert.equal(reserveNudges(ledger, T0 + 26 * HOUR).text, null);
  assert.deepEqual(reserveNudges(ledger, T0 + 50 * HOUR).items.map(item => item.id), ["offer"]);
  ledger = updateRequest(ledger, "question", { pendingOwner: { question: "Anything else?", askedAt: iso(T0 + 27 * HOUR) } }, T0 + 27 * HOUR);
  assert.deepEqual(reserveNudges(ledger, T0 + 27 * HOUR).items.map(item => item.id), ["question"]);
});

test("unresolved calendar writes appear in the view but only reconciliation owns their alerts", () => {
  const ledger = mixed();
  assert.equal(pipeline(ledger, T0 + 25 * HOUR, ["question"])[2]!.reason, "calendar-write");
  const batch = reserveNudges(ledger, T0 + 25 * HOUR, ["offer", "asked", "question"]);
  assert.equal(batch.text, null);
  assert.deepEqual(batch.ledger, ledger);
  assert.equal(reserveNudges(batch.ledger, T0 + 25 * HOUR).items.length, 3);
});

test("a booked replacement ages from its own offer and prior guest replies do not suppress it", () => {
  let ledger = recordGuestReply(offered(), "Chat-A", input.handle, T0 + HOUR);
  ledger = updateRequest(ledger, "offer", { status: "booked", booked: { ...offer } }, T0 + HOUR);
  assert.deepEqual(pipeline(ledger, T0 + 30 * HOUR), []);
  ledger = updateRequest(ledger, "offer", { reoffer: { offered: [offer], offeredAt: iso(T0 + 30 * HOUR) } }, T0 + 30 * HOUR);
  assert.equal(pipeline(ledger, T0 + 53 * HOUR)[0]!.nudge, false);
  assert.equal(pipeline(ledger, T0 + 54 * HOUR)[0]!.reason, "stale-offer");
  ledger = updateRequest(ledger, "offer", { reoffer: null }, T0 + 55 * HOUR);
  assert.deepEqual(pipeline(ledger, T0 + 55 * HOUR), []);
});

test("uncertain answer delivery is waiting on Meetly and nudges once for that attempt", () => {
  let ledger = mixed();
  ledger = updateRequest(ledger, "question", { pendingOwner: { ...request(ledger, "question").pendingOwner!, answerAttemptedAt: iso(T0 + HOUR) } }, T0 + HOUR);
  const batch = reserveNudges(ledger, T0 + HOUR);
  const item = batch.items.find(item => item.id === "question")!;
  assert.equal(item.state, "waiting_on_us");
  assert.match(item.detail, /do not resend automatically/);
  assert.equal(reserveNudges(batch.ledger, T0 + 2 * HOUR).text, null);
});

test("guest reply observation uses runtime chat, sender and time, including tool-free acknowledgements", async () => {
  let ledger = offered();
  let handler!: (event: any, ctx: any) => Promise<void>;
  const errors: string[] = [];
  registerPipelineHooks({ on(name: string, callback: typeof handler) { assert.equal(name, "message_received"); handler = callback; }, logger: { info(text: string) { errors.push(text); } } }, async (event, ctx) => {
    ledger = recordGuestReply(ledger, ctx.conversationId, ctx.senderId ?? event.senderId ?? event.from, event.timestamp);
  });
  const ctx = { channelId: "plow", accountId: "chat", conversationId: "Chat-A", senderId: input.handle };
  for (const context of [{ ...ctx, channelId: "other" }, { ...ctx, accountId: "email" }, { ...ctx, conversationId: "chat-a" }, { ...ctx, senderId: "plow-owner" }]) {
    await handler({ content: "Thanks!", timestamp: T0 + HOUR }, context);
    assert.equal(request(ledger).lastGuestReplyAt, undefined);
  }
  await handler({ content: "Thanks!", timestamp: T0 + HOUR }, { ...ctx, conversationId: "plow:Chat-A" });
  const before = structuredClone(ledger);
  assert.equal(request(ledger).lastGuestReplyAt, iso(T0 + HOUR));
  assert.equal(pipeline(ledger, T0 + 25 * HOUR)[0]!.nudge, false);
  await handler({ content: "Thanks!", timestamp: T0 + HOUR }, ctx);
  await handler({ content: "old reply", timestamp: T0 - HOUR }, ctx);
  assert.deepEqual(ledger, before, "duplicate and older messages do not reset reply time");
  assert.deepEqual(errors, []);
});

test("do-not-contact follows canonical identity, survives new requests, and clears across records", () => {
  let ledger = setDoNotContact(offered(), "+1 (555) 123-4567", true, T0 + HOUR);
  ledger = updateRequest(ledger, "offer", { status: "dropped" }, T0 + HOUR);
  const inbound = { ...input, origin: "inbound" as const, status: "asked" as const, chatUid: undefined, offered: [] };
  assert.deepEqual(saveRequest(ledger, inbound, T0 + 2 * HOUR, "ignored"), ledger);
  assert.deepEqual(addRequest(ledger, inbound, T0 + 2 * HOUR, "ignored"), ledger);
  assert.throws(() => checkContact(ledger, input.handle), /Confirm in the owner's DM/);
  assert.doesNotThrow(() => checkContact(ledger, input.handle, true));
  ledger = addRequest(ledger, input, T0 + 3 * HOUR, "new");
  assert.equal(request(ledger, "new").doNotContact, true);
  ledger = setDoNotContact(ledger, input.handle, false, T0 + 4 * HOUR);
  assert.equal(doNotContact(ledger, input.handle), false);
  assert.ok(ledger.requests.every(r => !r.doNotContact));
  assert.equal(doNotContact(ledger, "+15551234568"), false);
});

test("a never-scheduled contact's flag stays in a closed ledger record without pending outreach", () => {
  const ledger = setDoNotContact(empty(), " ALICE@Example.com ", true, T0, "Alice");
  assert.equal(ledger.requests.length, 1);
  assert.equal(ledger.requests[0]!.status, "dropped");
  assert.equal(doNotContact(ledger, "alice@example.com"), true);
  assert.deepEqual(pipeline(ledger, T0), []);
  assert.deepEqual(ledger.requests[0]!.log, [{ at: iso(T0), text: "Do not contact enabled" }]);
});

test("request logs record lifecycle and owner handoffs, survive replacement, and stay short", () => {
  let ledger = updateRequest(offered(), "offer", { pendingOwner: { question: "Lunch?", askedAt: iso(T0 + HOUR) } }, T0 + HOUR);
  ledger = saveRequest(ledger, input, T0 + 2 * HOUR, "ignored");
  ledger = updateRequest(ledger, "offer", { pendingOwner: null, status: "booked", booked: { ...offer } }, T0 + 3 * HOUR);
  assert.match(request(ledger).log!.map(entry => entry.text).join("\n"), /Request offered.*Waiting for owner answer.*Times offered.*Request booked; Owner question resolved/s);
  let r: Request = request(ledger);
  for (let i = 0; i < 30; i++) r = appendLog(r, `Change ${i}`, T0 + i);
  assert.equal(r.log!.length, 20);
  assert.equal(r.log![0]!.text, "Change 10");
  assert.equal(r.log!.at(-1)!.at, iso(T0 + 29));
});

test("CLI prints a readable pending view and one durable batch even with overlapping polls", async t => {
  const f = fixture(t);
  writeJson(f.path, mixed(Date.now() - 25 * HOUR));
  const before = readFileSync(f.path, "utf8");
  const view = cli("pipeline.ts", ["view"], f.env);
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.json.text, /Alex.*No guest reply/);
  assert.match(view.json.text, /Casey.*Waiting for your answer/);
  assert.equal(readFileSync(f.path, "utf8"), before, "view does not reserve notifications");
  const exec = promisify(execFile);
  const results = await Promise.all([1, 2].map(() => exec(process.execPath, [resolve("skills/meetly/scripts/pipeline.ts"), "nudge"], { env: { ...process.env, ...f.env } })));
  const batches = results.map(result => JSON.parse(result.stdout));
  assert.deepEqual(batches.map(batch => batch.items.length).sort(), [0, 3]);
  assert.equal(cli("pipeline.ts", ["nudge"], f.env).json.text, null, "an uncertain or failed send is never automatically repeated");
  t.diagnostic(view.json.text);
  t.diagnostic("Two concurrent local polls: one three-item owner DM batch; the other poll and subsequent poll print no message. No message was sent live.");
});

test("CLI skips unresolved writes and suppressed inbound saves can release the poll cursor", t => {
  const f = fixture(t);
  writeJson(f.path, mixed(Date.now() - 25 * HOUR));
  writeJson(join(f.home, "calendar", "offer.json"), { id: "pending" });
  assert.ok(!cli("pipeline.ts", ["nudge"], f.env).json.items.some((item: { id: string }) => item.id === "offer"));
  const blocked = cli("pipeline.ts", ["contact", "--handle", input.handle, "--blocked", "true"], f.env);
  assert.equal(blocked.status, 0, blocked.stderr);
  cli("cursor.ts", ["hold", "12"], f.env);
  const save = cli("ledger.ts", ["save", "--json", JSON.stringify({ ...input, origin: "inbound", status: "asked", chatUid: undefined, offered: [], sourceRowid: 12 })], f.env);
  assert.deepEqual(save.json, { skipped: "do-not-contact" });
  assert.equal(save.status, 0);
  cli("cursor.ts", ["release"], f.env);
  assert.equal(cli("cursor.ts", ["set", "12"], f.env).json.rowid, 12);
  assert.equal(cli("pipeline.ts", ["contact", "--handle", input.handle, "--blocked", "false"], f.env).json.doNotContact, false);
});

test("calendar CLI refuses flagged owner requests before any calendar or ledger mutation", t => {
  const f = fixture(t);
  const ledger = setDoNotContact(empty(), input.handle, true, T0);
  writeJson(f.path, ledger);
  const result = cli("calendar.ts", ["offer", "--json", JSON.stringify(input)], f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /marked do not contact.*Confirm in the owner's DM/);
  assert.deepEqual(readJson(f.path, empty()), JSON.parse(JSON.stringify(ledger)));
});
