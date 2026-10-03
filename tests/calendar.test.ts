import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { calendarAction, pendingCalendarWrites, type CalendarOptions } from "../skills/meetly/scripts/calendar.ts";
import { addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { macOutcome, type MacCommand, type MacOutcome } from "../skills/meetly/scripts/mac.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const start = "2026-10-05T10:00:00Z", end = "2026-10-05T10:30:00Z", account = "owner@example.com";
const now = Date.parse("2026-10-03T08:00:00Z");
function fixture(t: TestContext) {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; fs.rmSync(home, { recursive: true, force: true }); });
  const offered = [{ start, end, account, holdId: "hold-one" }, { start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", account, holdId: "hold-two" }];
  const input = { origin: "owner" as const, handle: "+15551234567", name: "Guest", topic: "Lunch", durationMin: 30, offered };
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, input, now - 72 * 3_600_000, "r_one"));
  writeJson(join(home, "config.json"), { ...DEFAULTS, defaultAccount: account, timezone: "UTC", ownerName: "Alex", setupDoneAt: new Date(now).toISOString(), calendars: [{account, id: account}] });
  const events = new Map<string, any>(offered.map(o => [o.holdId, { id: o.holdId, status: "confirmed", start: { dateTime: o.start }, end: { dateTime: o.end } }]));
  const calls: string[][] = [];
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]!;
  let counter = 0;
  const command = async ({ argv }: MacCommand): Promise<MacOutcome> => {
    calls.push(argv);
    const flag = (name: string) => argv[argv.indexOf(name) + 1]!;
    const verb = argv[2];
    if (verb === "events") {
      const token = argv.includes("--private-prop-filter") ? flag("--private-prop-filter").split("=")[1] : undefined;
      return { output: JSON.stringify({ events: [...events.values()].filter(e => !token || e.extendedProperties?.private?.meetlyOperation === token) }) };
    }
    if (verb === "event") return { output: JSON.stringify({ event: events.get(argv[4]!) }) };
    if (verb === "delete") { events.get(argv[4]!)!.status = "cancelled"; return { output: "deleted" }; }
    const id = verb === "update" ? argv[4]! : `new-${++counter}`;
    const event = { id, status: "confirmed", start: { dateTime: flag("--from") }, end: { dateTime: flag("--to") },
      extendedProperties: { private: { meetlyOperation: flag("--private-prop").split("=")[1] } },
      ...(argv.includes("--with-meet") ? { hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}) };
    events.set(id, event);
    return { output: JSON.stringify({ event }) };
  };
  return { home, input, offer: { ...input, offered: offered.map(({ holdId, ...slot }) => slot) }, read, calls, events, command, options: { command, now: () => now } satisfies CalendarOptions };
}

test("booking commits the event before deleting other holds; expiry cannot delete a just-booked event", async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "update") { entered(); await gate; }
    if (cmd.argv[2] === "delete") { assert.equal(f.read().status, "booked"); assert.notEqual(cmd.argv[4], f.read().eventId); }
    return f.command(cmd);
  };
  const book = calendarAction("r_one", { action: "book", start }, { ...f.options, command });
  await waiting;
  const expire = calendarAction("r_one", { action: "expire" }, f.options);
  release();
  await book;
  assert.equal((await expire).request.status, "booked");
  assert.equal(f.events.get("hold-one").status, "confirmed");
  assert.equal(f.events.get("hold-two").status, "cancelled");
});

test("expiry wins before a later booking and leaves no bookable stale holds", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "expire" }, f.options);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /expired/);
  assert.equal(f.read().status, "expired");
  assert.ok([...f.events.values()].every(e => e.status === "cancelled"));
});

test("a ledger commit failure after the calendar update resumes without repeating the write", async t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  let fail = true;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (fail && to === join(f.home, "ledger.json")) throw new Error("simulated commit failure");
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /simulated commit failure/);
  assert.equal(f.read().status, "offered");
  assert.ok(f.events.get("hold-one").extendedProperties.private.meetlyOperation);
  fail = false;
  await calendarAction("r_one", { action: "resume" }, f.options);
  assert.equal(f.read().status, "booked");
  assert.equal(f.calls.filter(c => c[2] === "update").length, 1);
});

test("failed replacement preserves old holds and offer and cleans only the new holds", async t => {
  const f = fixture(t), before = f.read().offered;
  let creates = 0;
  const command = async (cmd: MacCommand) => cmd.argv[2] === "create" && ++creates === 2 ? { error: "conflict" } : f.command(cmd);
  await assert.rejects(calendarAction("r_one", { action: "offer", request: f.offer }, { ...f.options, command }), /previous offer retained/);
  assert.deepEqual(f.read().offered, before);
  assert.equal(f.events.get("hold-one").status, "confirmed");
  assert.equal(f.events.get("hold-two").status, "confirmed");
  assert.equal(f.events.get("new-1").status, "cancelled");
  assert.deepEqual(f.read().holdCleanup, []);
});

test("ambiguous create reconciles by the persisted private marker without creating twice", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => { const result = await f.command(cmd); return cmd.argv[2] === "create" ? undefined : result; };
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, offered: [f.offer.offered[0]!] } }, { ...f.options, command });
  assert.equal(f.read().offered[0]!.holdId, "new-1");
  assert.equal(f.calls.filter(c => c[2] === "create").length, 1);
  assert.equal(f.calls.filter(c => c.includes("--private-prop-filter")).length, 1);
});

test("an unknown create that is not visible remains unresolved, blocking another write", async t => {
  const f = fixture(t);
  let creates = 0;
  const command = async (cmd: MacCommand) => cmd.argv[2] === "create" ? (creates++, undefined) : f.command(cmd);
  await assert.rejects(calendarAction("r_one", { action: "offer", request: f.offer }, { ...f.options, command }), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "resume" }, { ...f.options, command }), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /unresolved/);
  assert.equal(creates, 1);
  assert.deepEqual(f.read().offered, f.input.offered);
});

test("an unresolved create times out, releases the request and deletes a late event by its marker", async t => {
  const f = fixture(t);
  let clock = now, saved!: MacCommand, creates = 0;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "create") return f.command(cmd);
    if (++creates === 1) return f.command(cmd);
    saved = cmd;
    return { handle: "late-create" };
  };
  const options = { ...f.options, command, now: () => clock, poll: async () => ({ handle: "late-create" }) };
  await assert.rejects(calendarAction("r_one", { action: "offer", request: f.offer }, options), /unresolved/);
  clock += 9 * 60_000;
  await assert.rejects(calendarAction("r_one", { action: "resume" }, options), /unresolved/);
  clock += 60_000;
  await assert.rejects(calendarAction("r_one", { action: "resume" }, options), /previous offer retained/);
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.deepEqual(f.read().offered, f.input.offered);
  assert.equal(f.events.get("new-1").status, "cancelled");
  const token = saved.argv[saved.argv.indexOf("--private-prop") + 1]!.split("=")[1];
  assert.deepEqual(f.read().holdCleanup, [{ token, account, start: f.offer.offered[1]!.start, end: f.offer.offered[1]!.end }]);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.equal(f.read().holdCleanup!.length, 1);
  await calendarAction("r_one", { action: "book", start }, f.options);
  await f.command(saved);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.equal(f.events.get("new-2").status, "cancelled");
  assert.equal(f.events.get("hold-one").status, "confirmed");
  assert.deepEqual(f.read().holdCleanup, []);
  assert.equal(creates, 2);
});

for (const conflicting of [[0], [1], [0, 1]]) {
  test(`offer skips conflicting slots ${conflicting.join(",")} and fails only when none survive`, async t => {
    const f = fixture(t);
    for (const index of conflicting) {
      const slot = f.offer.offered[index]!;
      f.events.set(`busy-${index}`, { id: `busy-${index}`, status: "confirmed", start: { dateTime: slot.start }, end: { dateTime: slot.end } });
    }
    const offer = calendarAction("r_one", { action: "offer", request: f.offer }, f.options);
    if (conflicting.length === f.offer.offered.length) {
      await assert.rejects(offer, /previous offer retained/);
      assert.deepEqual(f.read().offered, f.input.offered);
      assert.equal(f.events.get("hold-one").status, "confirmed");
      assert.equal(f.events.get("hold-two").status, "confirmed");
    } else {
      const result = await offer;
      assert.deepEqual(result.request.offered, [{ ...f.offer.offered[1 - conflicting[0]!]!, holdId: "new-1" }]);
      assert.equal(f.events.get("new-1").status, "confirmed");
      assert.equal(f.events.get("hold-one").status, "cancelled");
      assert.equal(f.events.get("hold-two").status, "cancelled");
    }
    assert.equal(f.calls.filter(c => c[2] === "create").length, 2 - conflicting.length);
    assert.deepEqual(pendingCalendarWrites(), []);
    for (const index of conflicting) assert.equal(f.events.get(`busy-${index}`).status, "confirmed");
  });
}

for (const refused of [[0], [1], [0, 1]]) for (const pending of [false, true]) {
  test(`Latch busy refusals skip offer slots ${refused.join(",")} (${pending ? "polled" : "immediate"})`, async t => {
    const f = fixture(t), before = f.read().offered;
    const refusal = async () => {
      const error = { status: "error", error: "the slot is busy — owner@example.com: busy 2026-10-05T10:00:00Z/2026-10-05T10:30:00Z; could not check: holidays. Follow the Google Workspace skill's conflict rule before re-sending the same command with --confirm-conflict; this refusal carries busy times only." };
      const result = await macOutcome(pending ? "plow_get_result" : "plow_run_command", {}, { token: "test", fetch: async () => new Response(JSON.stringify({
        result: { content: [{ type: "text", text: JSON.stringify(pending ? { status: "ready", result: error } : error) }] },
      })) });
      assert.deepEqual(result, { error: "Calendar slot is busy", code: "calendar-conflict" });
      return result;
    };
    const writes: string[][] = [];
    const command = async (cmd: MacCommand) => {
      if (cmd.argv[2] === "create") {
        writes.push(cmd.argv);
        if (refused.includes(writes.length - 1)) return pending ? { handle: "busy-slot" } : refusal();
      }
      return f.command(cmd);
    };
    // The selected-calendar conflict gate sees a busy calendar outside the
    // configured preflight scope, even though these reads report no conflicts.
    for (const event of f.events.values()) event.status = "cancelled";
    const options = { ...f.options, command, poll: async () => refusal() };
    const offer = calendarAction("r_one", { action: "offer", request: f.offer }, options);
    if (refused.length === f.offer.offered.length) {
      await assert.rejects(offer, /previous offer retained/);
      assert.deepEqual(f.read().offered, before);
    } else {
      const result = await offer;
      assert.deepEqual(result.request.offered, [{ ...f.offer.offered[1 - refused[0]!]!, holdId: "new-1" }]);
      assert.equal(f.events.get("new-1").status, "confirmed");
      assert.deepEqual(result.request.holdCleanup, []);
    }
    assert.equal(writes.length, 2, "attempt each candidate once, including after a refusal");
    assert.ok(writes.every(argv => !argv.includes("--confirm-conflict")), "never retry a refusal with an override");
    assert.deepEqual(pendingCalendarWrites(), []);
  });
}

test("ambiguous update and delete reconcile by event id", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => { const result = await f.command(cmd); return ["update", "delete"].includes(cmd.argv[2]!) ? undefined : result; };
  await calendarAction("r_one", { action: "book", start }, { ...f.options, command });
  assert.equal(f.read().status, "booked");
  assert.deepEqual(f.read().holdCleanup, []);
  assert.equal(f.calls.filter(c => c[2] === "update").length, 1);
  assert.equal(f.calls.filter(c => c[2] === "delete").length, 1);
});

test("an update whose reread lacks its marker fails and releases the request without deleting its hold", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => cmd.argv[2] === "update" ? undefined : f.command(cmd);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, { ...f.options, command }), /previous offer retained/);
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.deepEqual(f.read().offered, f.input.offered);
  assert.equal(f.read().status, "offered");
  assert.equal(f.events.get("hold-one").status, "confirmed");
  assert.equal(f.events.get("hold-two").status, "confirmed");
  assert.ok(f.calls.every(c => c[2] !== "delete"));
  await calendarAction("r_one", { action: "book", start }, f.options);
  assert.equal(f.read().status, "booked");
});

test("a delayed Latch approval resumes its handle without sending the update again", async t => {
  const f = fixture(t);
  let saved!: MacCommand, sends = 0, ready = false;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "event" && saved && !ready) return undefined;
    if (cmd.argv[2] !== "update") return f.command(cmd);
    saved = cmd; sends++; return { handle: "approval-one" };
  };
  const poll = async (handle: string) => {
    assert.equal(handle, "approval-one");
    return ready ? f.command(saved) : { handle };
  };
  await assert.rejects(calendarAction("r_one", { action: "book", start }, { ...f.options, command, poll }), /unresolved/);
  ready = true;
  await calendarAction("r_one", { action: "resume" }, { ...f.options, command, poll });
  assert.equal(f.read().status, "booked");
  assert.equal(sends, 1);
});
