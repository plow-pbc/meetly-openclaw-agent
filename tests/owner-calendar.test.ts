import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import plugin from "../plugin/index.js";

import { rmSync } from "node:fs";
import { join } from "node:path";
import { registerOwnerCalendarTool } from "../plugin/owner-calendar.js";
import { changeOwnerMeeting } from "../skills/meetly/scripts/owner-calendar.ts";
import { calendarAction } from "../skills/meetly/scripts/calendar.ts";
import { addRequest, updateRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, fakeCalendar, tmpHome } from "./helpers.ts";

test("private calendar changes expose a typed tool so delivered travel corrections can silence the runtime", () => {
  const tools: any[] = [];
  plugin.register({ registerTool(factory: any) { tools.push(factory({})); }, on() {}, logger: { info() {} } });
  for (const name of ["meetly_set_owner_travel", "meetly_set_owner_format"])
    assert.ok(tools.find(tool => tool.name === name), "CLI text cannot convey a typed silent result to the channel");
  assert.ok(tools.find(tool => tool.name === "meetly_set_owner_format").parameters.required.includes("format"));
});

const ctx = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "owner",
  sessionKey: "agent:main:main", nativeChannelId: "owner-dm" };
const start = "2026-10-27T11:30:00Z", end = "2026-10-27T12:30:00Z", account = "owner@example.test";
async function fixture(t: TestContext, failGuest = false, failOwner = false) {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; rmSync(home, { recursive: true, force: true }); });
  const now = Date.parse("2026-10-04T12:00:00Z");
  writeJson(join(home, "config.json"), { ...DEFAULTS, travelBase: "Office", defaultAccount: account, timezone: "UTC", ownerName: "Alex",
    setupDoneAt: new Date(now).toISOString(), calendars: [{ account, id: account }] });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, { origin: "owner", handle: "+15550000002", name: "Guest", topic: "lunch",
    format: "in_person", location: "Bakery", durationMin: 60, chatUid: "guest-group", travel: { beforeMin: 20, afterMin: 20 },
    offered: [{ start, end, account, holdId: "meeting" }] }, now, "r_one"));
  const cal = fakeCalendar([calendarEvent("meeting", start, end)]);
  const options = { command: cal.command, now: () => now };
  await calendarAction("r_one", { action: "book", start }, options);
  const notes: string[] = [], guests: { to: string; text: string }[] = [];
  const send = async (text: string) => { notes.push(text); if (failOwner) throw new Error("unknown owner delivery"); };
  const sendGuest = async (to: string, text: string) => {
    const request = readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]!;
    assert.equal(cal.events.get("meeting")!.location, request.format === "phone" ? "Phone call" : request.location, "write must finish before guest delivery");
    guests.push({ to, text });
    if (failGuest) throw new Error("unknown guest delivery");
  };
  const tools = new Map<string, any>();
  registerOwnerCalendarTool({ registerTool(factory: any) { const tool = factory(ctx); tools.set(tool.name, tool); } },
    (context: any, args: any) => changeOwnerMeeting(context, args, send, options, sendGuest));
  const tool = { execute: (id: string, args: any) => tools.get(`meetly_set_owner_${args.action}`).execute(id, args) };
  return { ...cal, home, options, notes, guests, tool, read: () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]! };
}

test("travel correction returns channel silence; a later place estimate reports the 45 minutes actually held", async t => {
  const f = await fixture(t);
  const corrected = await f.tool.execute("travel", { requestId: "r_one", action: "travel", travel: { beforeMin: 45, afterMin: 45 } });
  assert.equal(corrected.isError, false);
  assert.equal(corrected.details.silent, true, "silence must be structured metadata for the Plow channel");
  const placed = await f.tool.execute("place", { requestId: "r_one", action: "format", format: "in_person", location: "Cafe", confirmation: "The lunch is now at Cafe.",
    travel: { beforeMin: 15, afterMin: 15, override: true } });
  assert.equal(placed.isError, false);
  assert.equal(placed.details.silent, true, "the owner and guest were both notified");
  assert.deepEqual(placed.details.effectiveTravel, { beforeMin: 45, afterMin: 45, override: true });
  assert.deepEqual(f.read().travel, placed.details.effectiveTravel);
  assert.deepEqual(f.read().booked, { start, end, account });
  assert.deepEqual(f.read().travelEvents!.map(ref => {
    const event = f.events.get(ref.holdId)!;
    return [event.start.dateTime, event.end.dateTime];
  }), [["2026-10-27T10:45:00.000Z", start], [end, "2026-10-27T13:15:00.000Z"]]);
  assert.equal(f.notes.length, 2);
  assert.match(f.notes[1]!, /Held 45 min travel before and 45 min after lunch at Cafe/);
  assert.equal(placed.details.request.travel, undefined, "shared request projection remains safe");
  assert.deepEqual(placed.details.guestConfirmation, { delivered: true });
  const phone = await f.tool.execute("phone", { requestId: "r_one", action: "format", format: "phone", confirmation: "The lunch is now a phone call.", travel: { beforeMin: 0, afterMin: 0 } });
  assert.deepEqual(phone.details.effectiveTravel, { beforeMin: 0, afterMin: 0 });
  assert.equal(f.read().travelEvents!.length, 0);
});

test("unknown note delivery and calendar errors remain audible without retrying", async t => {
  const f = await fixture(t);
  let sends = 0;
  const args = { requestId: "r_one", action: "travel" as const, travel: { beforeMin: 45, afterMin: 45 } };
  const result = await changeOwnerMeeting(ctx, args, async () => { sends++; throw new Error("unknown"); }, f.options);
  assert.equal(sends, 1);
  assert.equal(result.silent, undefined);
  assert.equal(result.ownerNotified, false);
  assert.deepEqual(result.effectiveTravel, f.read().travel);
  const failed = await changeOwnerMeeting(ctx, { ...args, travel: { beforeMin: -1, afterMin: 45 } }, async () => assert.fail("must not notify"), f.options);
  assert.ok(failed.error);
  assert.equal(failed.silent, undefined);
});

test("private travel facts and writes are unavailable to guests, groups and other channels", async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.read()), count = f.calls.length;
  for (const context of [{}, { ...ctx, senderIsOwner: false }, { ...ctx, sessionKey: "group" }, { ...ctx, agentAccountId: "email" },
    { ...ctx, messageChannel: "webchat" }, { ...ctx, requesterSenderId: undefined }]) {
    const result = await changeOwnerMeeting(context, { requestId: "r_one", action: "travel", travel: { beforeMin: 45, afterMin: 45 } },
      async () => assert.fail("must not notify"), f.options);
    assert.ok(result.error);
    assert.equal(result.effectiveTravel, undefined);
  }
  assert.equal(JSON.stringify(f.read()), before);
  assert.equal(f.calls.length, count);
});


test("a place change delivers and clears the pending guest question before silencing", async t => {
  const f = await fixture(t);
  const pendingOwner = { question: "Could we meet at Cafe?", askedAt: "2026-10-04T12:00:00Z" };
  writeJson(join(f.home, "ledger.json"), updateRequest({ requests: [f.read()] }, "r_one", { pendingOwner }, Date.now()));
  const result = await f.tool.execute("place", { requestId: "r_one", action: "format", format: "in_person", location: "Cafe", confirmation: "The lunch is now at Cafe.", travel: { beforeMin: 15, afterMin: 15 } });
  assert.deepEqual(result.details.guestConfirmation, { delivered: true });
  assert.equal(result.details.ownerNotified, true);
  assert.equal(result.details.silent, true);
  assert.equal(f.read().pendingOwner, undefined);
  assert.equal(f.guests.length, 1);
});

for (const pending of [false, true]) for (const failGuest of [false, true]) test(`owner format completion silences only after confirmed guest delivery: pending=${pending}, failure=${failGuest}`, async t => {
  const f = await fixture(t, failGuest);
  if (pending) writeJson(join(f.home, "ledger.json"), updateRequest({ requests: [f.read()] }, "r_one", {
    pendingOwner: { question: "Could we phone instead?", askedAt: "2026-10-04T12:00:00Z" },
  }, Date.now()));
  const result = await f.tool.execute("phone", { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Your meeting with Alex is now a phone call." });
  assert.equal(f.read().format, "phone");
  assert.equal(f.guests.length, 1);
  assert.equal(f.guests[0]!.to, "guest-group");
  assert.equal(f.notes.length, 1);
  if (failGuest) {
    assert.equal(result.isError, true);
    assert.notEqual(result.details.silent, true);
    assert.equal(result.details.ownerReply, undefined, "failed delivery must not inherit a silence instruction");
    if (pending) assert.ok(f.read().pendingOwner?.answerAttemptedAt);
  } else {
    assert.equal(result.isError, false);
    assert.equal(result.details.silent, true, "channel must suppress even a generated Done reply");
    assert.equal(result.details.guestConfirmation.delivered, true);
    assert.equal(f.read().pendingOwner, undefined);
    assert.equal(result.details.request.pendingOwner, undefined);
  }
});

test("uncertain owner notification stays reportable after successful guest delivery", async t => {
  const f = await fixture(t, false, true);
  const result = await f.tool.execute("phone", { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Your meeting with Alex is now a phone call." });
  assert.equal(f.guests.length, 1);
  assert.equal(result.details.ownerNotified, false);
  assert.notEqual(result.details.silent, true);
});


test("invalid format confirmation or a failed write never sends a guest confirmation", async t => {
  const f = await fixture(t), before = JSON.stringify(f.read());
  for (const confirmation of [undefined, " "]) {
    const result = await f.tool.execute("invalid", { requestId: "r_one", action: "format", format: "phone",
      travel: { beforeMin: 0, afterMin: 0 }, confirmation });
    assert.equal(result.isError, true);
    assert.notEqual(result.details.silent, true);
    assert.equal(JSON.stringify(f.read()), before);
  }
  const result = await changeOwnerMeeting(ctx, { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Your meeting is now a phone call." },
    async () => assert.fail("must not notify"), { ...f.options, command: async () => { throw new Error("calendar unavailable"); } },
    async () => assert.fail("must not send"));
  assert.ok(result.error);
  assert.notEqual(result.silent, true);
  assert.equal(f.guests.length, 0);
  assert.equal(f.notes.length, 0);
});

test("email format changes retain their separate delivery receipt flow and remain audible", async t => {
  const f = await fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), channel: "email" }] });
  const result = await f.tool.execute("email", { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Your meeting is now a phone call." });
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.guestConfirmation, { delivered: false, tool: "plow_send_email", to: "guest-group" });
  assert.notEqual(result.details.silent, true);
  assert.equal(f.guests.length, 0);
});

test("an in-person confirmation without a location cannot clear the place or send a false update", async t => {
  const f = await fixture(t), before = JSON.stringify(f.read());
  const result = await f.tool.execute("missing-place", { requestId: "r_one", action: "format", format: "in_person",
    travel: { beforeMin: 15, afterMin: 15 }, confirmation: "Alex will meet you at Cafe." });
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(f.read()), before);
  assert.equal(f.guests.length, 0);
  assert.equal(f.notes.length, 0);
  assert.notEqual(result.details.silent, true);
});

for (const pending of [false, true]) test(`assent to an already applied phone change writes nothing and only answers an open question: pending=${pending}`, async t => {
  const f = await fixture(t);
  await calendarAction("r_one", { action: "format", format: "phone", travel: { beforeMin: 0, afterMin: 0 } }, f.options);
  if (pending) writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), pendingOwner: {
    question: "Is phone okay?", askedAt: "2026-10-04T12:00:00Z",
  } }] });
  const count = f.calls.length;
  const result = await f.tool.execute("assent", { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Alex is happy to do a phone call." });
  assert.equal(result.details.unchanged, true);
  assert.equal(f.calls.length, count, "an unchanged format must not rewrite the calendar");
  assert.equal(f.guests.length, pending ? 1 : 0);
  assert.equal(f.notes.length, 0);
  assert.equal(result.details.silent, true);
  assert.equal(f.read().pendingOwner, undefined);
});

test("a meal's stale venue cannot survive a place change in its calendar title or private note", async t => {
  const f = await fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), meal: "lunch", topic: "lunch at Bakery" }] });
  const result = await f.tool.execute("place", { requestId: "r_one", action: "format", format: "in_person", location: "Cafe",
    travel: { beforeMin: 15, afterMin: 15 }, confirmation: "Lunch is now at Cafe." });
  assert.equal(result.isError, false);
  const update = f.calls.filter(argv => argv[2] === "update").at(-1)!;
  assert.equal(update[update.indexOf("--summary") + 1], "lunch with Guest");
  assert.match(f.notes[0]!, /after lunch at Cafe/);
  assert.doesNotMatch(f.notes[0]!, /Bakery/);
});

test("an unchanged calendar does not silence an uncertain pending-answer delivery", async t => {
  const f = await fixture(t, true);
  await calendarAction("r_one", { action: "format", format: "phone", travel: { beforeMin: 0, afterMin: 0 } }, f.options);
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), pendingOwner: {
    question: "Is phone okay?", askedAt: "2026-10-04T12:00:00Z",
  } }] });
  const count = f.calls.length;
  const result = await f.tool.execute("assent", { requestId: "r_one", action: "format", format: "phone",
    travel: { beforeMin: 0, afterMin: 0 }, confirmation: "Alex is happy to do a phone call." });
  assert.equal(f.calls.length, count);
  assert.equal(result.isError, true);
  assert.notEqual(result.details.silent, true);
  assert.equal(f.guests.length, 1);
  assert.ok(f.read().pendingOwner?.answerAttemptedAt);
});

test("non-meal purposes remain intact when the meeting moves", async t => {
  const f = await fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), topic: "Research at coastal farms" }] });
  await f.tool.execute("place", { requestId: "r_one", action: "format", format: "in_person", location: "Cafe",
    travel: { beforeMin: 15, afterMin: 15 }, confirmation: "The meeting is now at Cafe." });
  const update = f.calls.filter(argv => argv[2] === "update").at(-1)!;
  assert.equal(update[update.indexOf("--summary") + 1], "Research at coastal farms with Guest");
});
