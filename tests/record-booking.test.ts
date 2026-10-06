import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addRequest, updateRequest, type Ledger, type NewRequest } from "../skills/meetly/scripts/ledger.ts";
import { parseEvent, type EventInfo } from "../skills/meetly/scripts/event.ts";
import { recordBooking } from "../skills/meetly/scripts/record-booking.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures", "calendar");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
const T0 = Date.parse("2026-09-28T12:00:00Z");
const ACCOUNT = "owner@example.com";
const offer = { start: "2026-10-10T04:00:00-03:00", end: "2026-10-10T04:30:00-03:00", holdId: "evt123abc", account: ACCOUNT };
const input = (over: Record<string, unknown> = {}) => ({
  travel: { beforeMin: 0, afterMin: 0 },
  origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, offered: [offer], chatUid: "c1", ...over,
}) as NewRequest;
const meetEvent = (): EventInfo => parseEvent(fixture("event-meet"));
const plainEvent = (): EventInfo => parseEvent(fixture("event-plain"));
const offered = (format = "meet"): Ledger => addRequest({ requests: [] }, input({ format }), T0, "r_1");

test("booking a Meet records the event, its time, its account and its link", () => {
  const { ledger, meetUrl, warning } = recordBooking(offered("meet"), "r_1", meetEvent(), ACCOUNT, T0);
  const r = ledger.requests[0]!;
  assert.equal(r.status, "booked");
  assert.equal(r.eventId, "evt123abc");
  assert.deepEqual(r.booked, { start: "2026-10-10T04:00:00-03:00", end: "2026-10-10T04:30:00-03:00", account: ACCOUNT });
  assert.equal(r.meetUrl, "https://meet.google.com/sai-nvgi-cdg");
  assert.equal(meetUrl, "https://meet.google.com/sai-nvgi-cdg");
  assert.equal(warning, undefined);
});

test("a Meet booked without a link is still booked, with a warning and no link", () => {
  const { ledger, meetUrl, warning } = recordBooking(offered("meet"), "r_1", plainEvent(), ACCOUNT, T0);
  assert.equal(ledger.requests[0]!.status, "booked");
  assert.equal("meetUrl" in ledger.requests[0]!, false);
  assert.equal(meetUrl, null);
  assert.equal(warning, "no-meet-link");
});

test("an in-person, phone or unknown meeting never keeps a link, even when the event has one", () => {
  for (const format of ["in_person", "phone", "unknown"]) {
    const { ledger, meetUrl, warning } = recordBooking(offered(format), "r_1", meetEvent(), ACCOUNT, T0);
    assert.equal(ledger.requests[0]!.status, "booked", format);
    assert.equal("meetUrl" in ledger.requests[0]!, false, format);
    assert.equal(meetUrl, null, format);
    assert.equal(warning, undefined, format);
  }
});

for (const [start, retained] of [[offer.start, true], ["2026-10-10T07:00:00Z", true], ["2026-10-10T08:00:00Z", false]] as const)
test(`booking retains only the approval for its actual start: ${start}`, () => {
  let l = offered("meet");
  const pending = { start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString(), askedAt: new Date(T0).toISOString() };
  l = updateRequest(l, "r_1", { pendingOwner: pending }, T0);
  assert.deepEqual(recordBooking(l, "r_1", meetEvent(), ACCOUNT, T0).ledger.requests[0]!.pendingOwner, retained ? pending : undefined);
});

test("a format answered after booking: recording the updated event adds the link", () => {
  let l = recordBooking(offered("unknown"), "r_1", plainEvent(), ACCOUNT, T0).ledger;
  l = updateRequest(l, "r_1", { format: "meet" }, T0);
  const { ledger, meetUrl } = recordBooking(l, "r_1", meetEvent(), ACCOUNT, T0);
  assert.equal(ledger.requests[0]!.meetUrl, "https://meet.google.com/sai-nvgi-cdg");
  assert.equal(meetUrl, "https://meet.google.com/sai-nvgi-cdg");
});

test("re-recording a moved event resets the reminder; the same time keeps it", () => {
  let l = recordBooking(offered("meet"), "r_1", meetEvent(), ACCOUNT, T0).ledger;
  l = updateRequest(l, "r_1", { reminder: { at: new Date(T0).toISOString(), outcome: "sent" } }, T0);
  assert.ok(recordBooking(l, "r_1", meetEvent(), ACCOUNT, T0).ledger.requests[0]!.reminder);
  const moved = { ...meetEvent(), start: "2026-10-10T05:00:00-03:00", end: "2026-10-10T05:30:00-03:00" };
  assert.equal("reminder" in recordBooking(l, "r_1", moved, ACCOUNT, T0).ledger.requests[0]!, false);
});

test("refuses a cancelled event, another event for a booked request, a closed request, an unknown id and an empty account", () => {
  const cancelled = parseEvent(fixture("event-cancelled"));
  assert.throws(() => recordBooking(offered(), "r_1", cancelled, ACCOUNT, T0), /cancelled/);
  const booked = recordBooking(offered(), "r_1", meetEvent(), ACCOUNT, T0).ledger;
  assert.throws(() => recordBooking(booked, "r_1", { ...meetEvent(), id: "other" }, ACCOUNT, T0), /already booked as evt123abc/);
  for (const status of ["dropped", "expired"] as const) {
    const closed = updateRequest(offered(), "r_1", { status }, T0);
    assert.throws(() => recordBooking(closed, "r_1", meetEvent(), ACCOUNT, T0), new RegExp(status));
  }
  assert.throws(() => recordBooking(offered(), "nope", meetEvent(), ACCOUNT, T0), /no request nope/);
  assert.throws(() => recordBooking(offered(), "r_1", meetEvent(), "", T0), /account/);
});

for (const alternatives of [false, true]) test(`booking clears only obsolete alternative decisions: alternatives=${alternatives}`, () => {
  const pending = { question: "Can we find another time?", askedAt: new Date(T0).toISOString(),
    ...(alternatives ? { alternatives: { previousStarts: [offer.start] } } : {}) };
  const ledger = updateRequest(offered(), "r_1", { pendingOwner: pending }, T0);
  const result = recordBooking(ledger, "r_1", meetEvent(), ACCOUNT, T0).ledger.requests[0]!;
  assert.deepEqual(result.pendingOwner, alternatives ? undefined : pending);
});
