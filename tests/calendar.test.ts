import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { calendarAction, offerRequest, pendingCalendarWrites, resumePending, type CalendarOptions } from "../skills/meetly/scripts/calendar.ts";
import { setDoNotContact, addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { macOutcome, type MacCommand, type MacOutcome } from "../skills/meetly/scripts/mac.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, fakeCalendar, cli, tmpHome } from "./helpers.ts";

const start = "2026-10-05T10:00:00Z", end = "2026-10-05T10:30:00Z", account = "owner@example.com";
const now = Date.parse("2026-10-03T08:00:00Z");
function fixture(t: TestContext, chatUid?: string) {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; fs.rmSync(home, { recursive: true, force: true }); });
  const offered = [{ start, end, account, holdId: "hold-one" }, { start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", account, holdId: "hold-two" }];
  const input = { origin: "owner" as const, handle: "+15551234567", name: "Guest", chatUid, topic: "Lunch", durationMin: 30, offered };
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, input, now - 72 * 3_600_000, "r_one"));
  writeJson(join(home, "config.json"), { ...DEFAULTS, defaultAccount: account, timezone: "UTC", ownerName: "Alex", setupDoneAt: new Date(now).toISOString(), calendars: [{account, id: account}] });
  const { events, calls, command } = fakeCalendar(offered.map(o => calendarEvent(o.holdId, o.start, o.end)));
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]!;
  return { home, input, offer: { ...input, offered: offered.map(({ holdId, ...slot }) => slot) }, read, calls, events, command, options: { command, now: () => now } satisfies CalendarOptions };
}

for (const status of ["offered", "booked"] as const) for (const location of [undefined, "Cafe"]) test(`a ${status} format change ${location === undefined ? "clears an omitted" : "keeps an explicit"} location`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Library" }, f.options);
  if (status === "booked") await calendarAction("r_one", { action: "book", start }, f.options);
  if (status === "offered") {
    const changed = cli("calendar.ts", ["format", "--id", "r_one", "--json", JSON.stringify({ format: "meet", location })], { MEETLY_HOME: f.home });
    assert.equal(changed.status, 0, changed.stderr);
  } else await calendarAction("r_one", { action: "format", format: "meet", location }, f.options);
  assert.equal(f.read().status, status);
  assert.equal(f.read().format, "meet");
  assert.equal(f.read().location, location ?? "");
  if (status === "offered") await calendarAction("r_one", { action: "book", start }, f.options);
  const event = f.events.get(f.read().eventId!)!;
  assert.equal(f.read().meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(event.hangoutLink, f.read().meetUrl);
  assert.equal(event.location, f.read().location);
});

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
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.equal(f.events.get("hold-two")!.status, "cancelled");
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
  assert.ok(f.events.get("hold-one")!.extendedProperties!.private.meetlyOperation);
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
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.equal(f.events.get("hold-two")!.status, "confirmed");
  assert.equal(f.events.get("new-1")!.status, "cancelled");
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
  assert.equal(f.events.get("new-1")!.status, "cancelled");
  const token = saved.argv[saved.argv.indexOf("--private-prop") + 1]!.split("=")[1];
  assert.deepEqual(f.read().holdCleanup, [{ token, account, start: f.offer.offered[1]!.start, end: f.offer.offered[1]!.end }]);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.equal(f.read().holdCleanup!.length, 1);
  await calendarAction("r_one", { action: "book", start }, f.options);
  await f.command(saved);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.equal(f.events.get("new-2")!.status, "cancelled");
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
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
      assert.equal(f.events.get("hold-one")!.status, "confirmed");
      assert.equal(f.events.get("hold-two")!.status, "confirmed");
    } else {
      const result = await offer;
      assert.deepEqual(result.request.offered, [{ ...f.offer.offered[1 - conflicting[0]!]!, holdId: "new-1" }]);
      assert.equal(f.events.get("new-1")!.status, "confirmed");
      assert.equal(f.events.get("hold-one")!.status, "cancelled");
      assert.equal(f.events.get("hold-two")!.status, "cancelled");
    }
    assert.equal(f.calls.filter(c => c[2] === "create").length, 2 - conflicting.length);
    assert.deepEqual(pendingCalendarWrites(), []);
    for (const index of conflicting) assert.equal(f.events.get(`busy-${index}`)!.status, "confirmed");
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
      assert.equal(f.events.get("new-1")!.status, "confirmed");
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

test("a markerless reread keeps a lost update unresolved until its late completion", async t => {
  const f = fixture(t);
  let saved!: MacCommand, writes = 0;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "update") return f.command(cmd);
    saved = cmd; writes++; return undefined;
  };
  const options = { ...f.options, command };
  await assert.rejects(calendarAction("r_one", { action: "book", start }, options), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "resume" }, options), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "book", start: f.input.offered[1]!.start }, options), /unresolved/);
  assert.deepEqual(pendingCalendarWrites(), ["r_one"]);
  assert.deepEqual(f.read().offered, f.input.offered);
  assert.ok(f.calls.every(c => c[2] !== "delete"));
  await f.command(saved);
  await calendarAction("r_one", { action: "resume" }, options);
  assert.equal(f.read().status, "booked");
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(writes, 1);
  assert.deepEqual(pendingCalendarWrites(), []);
});

test("a delayed Latch approval resumes its handle without sending the update again", async t => {
  const f = fixture(t);
  let saved!: MacCommand, sends = 0, ready = false;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "update") return f.command(cmd);
    saved = cmd; sends++; return { handle: "approval-one" };
  };
  const poll = async (handle: string) => {
    assert.equal(handle, "approval-one");
    return ready ? f.command(saved) : { handle };
  };
  await assert.rejects(calendarAction("r_one", { action: "book", start }, { ...f.options, command, poll }), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "resume" }, { ...f.options, command, poll }), /unresolved/);
  assert.equal(f.calls.filter(c => c[2] === "event").length, 1, "only the pre-write read is allowed while approval is pending");
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  ready = true;
  await calendarAction("r_one", { action: "resume" }, { ...f.options, command, poll });
  assert.equal(f.read().status, "booked");
  assert.equal(sends, 1);
});


test("cancelling a booked hold notifies attendees and retains that mode across cleanup retries", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "guest@example.com" }, f.options);
  const command = async (cmd: MacCommand) => cmd.argv[2] === "delete" ? { error: "offline" } : f.command(cmd);
  await calendarAction("r_one", { action: "cancel" }, { ...f.options, command });
  assert.equal(f.read().status, "dropped");
  assert.deepEqual(f.read().holdCleanup, [{ holdId: "hold-one", account, sendUpdates: "all" }]);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  const deleted = f.calls.filter(c => c[2] === "delete");
  assert.equal(deleted.find(c => c[4] === "hold-two")?.includes("none"), true);
  assert.equal(deleted.find(c => c[4] === "hold-one")?.includes("all"), true);
  assert.deepEqual(f.read().holdCleanup, []);
});

test("an abandoned attendee-bearing create notifies invitees when its late event is cleaned", async t => {
  const f = fixture(t);
  for (const event of f.events.values()) event.status = "cancelled";
  let saved!: MacCommand, clock = now;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "create") return f.command(cmd);
    saved = cmd; return undefined;
  };
  const options = { ...f.options, command, now: () => clock };
  await assert.rejects(calendarAction("r_one", { action: "book", start, attendees: "guest@example.com" }, options), /unresolved/);
  clock += 10 * 60_000;
  await assert.rejects(calendarAction("r_one", { action: "resume" }, options), /failed/);
  assert.equal(f.read().holdCleanup?.[0]?.sendUpdates, "all");
  await f.command(saved);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.equal(f.calls.find(c => c[2] === "delete" && c[4] === "new-1")?.includes("all"), true);
  assert.deepEqual(f.read().holdCleanup, []);
});

for (const deferred of [false, true]) test(`a failed first offer closes its provisional row and preserves cleanup (${deferred ? "resumed" : "immediate"})`, async t => {
  const f = fixture(t);
  fs.rmSync(join(f.home, "ledger.json"));
  f.events.clear();
  let creates = 0;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "create" && ++creates === 2) return deferred ? { handle: "refused" } : { error: "failed" };
    if (cmd.argv[2] === "delete") return { error: "offline" };
    return f.command(cmd);
  };
  const options = { ...f.options, command, poll: async () => ({ handle: "refused" }) };
  await assert.rejects(offerRequest(f.offer, options), deferred ? /unresolved/ : /failed/);
  const id = f.read().id;
  if (deferred) {
    assert.equal(f.read().status, "offered");
    await assert.rejects(calendarAction(id, { action: "resume" }, { ...options, poll: async () => ({ error: "failed" }) }), /failed/);
  }
  assert.equal(f.read().status, "dropped");
  assert.deepEqual(f.read().holdCleanup, [{ holdId: "new-1", account }]);
  const next = addRequest({ requests: [f.read()] }, { ...f.input, sourceRowid: 99, status: "asked", offered: [] }, now, "r_next");
  assert.equal(next.requests[1]!.status, "asked");
  await calendarAction(id, { action: "cleanup" }, f.options);
  assert.deepEqual(f.read().holdCleanup, []);
});


test("resume-pending continues past an unresolved update and reconciles another request", async t => {
  const f = fixture(t);
  assert.deepEqual(cli("calendar.ts", ["resume-pending"], { MEETLY_HOME: f.home }).json, { results: [] });
  let hideCreated = true;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "update") return undefined;
    if (hideCreated && cmd.argv.includes("--private-prop-filter")) return { output: '{"events":[]}' };
    const result = await f.command(cmd);
    return cmd.argv[2] === "create" ? undefined : result;
  };
  const options = { ...f.options, command };
  await assert.rejects(calendarAction("r_one", { action: "book", start }, options), /unresolved/);
  await assert.rejects(offerRequest({ ...f.offer, handle: "+15557654321", offered: [
    { start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", account },
  ] }, options), /unresolved/);
  hideCreated = false;
  const { results } = await resumePending(options);
  assert.equal(results.length, 2);
  assert.match(results.find(r => r.id === "r_one")!.error!, /unresolved/);
  const resumed = results.find(r => r.id !== "r_one")!;
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.request!.offered[0]!.holdId, "new-1");
  assert.deepEqual(pendingCalendarWrites(), ["r_one"]);
  assert.equal(f.calls.filter(c => c[2] === "create").length, 1);
});

test("a queued pick cannot move a meeting booked while it waits for the calendar lock", async t => {
  const f = fixture(t);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "update") { entered(); await gate; }
    return f.command(cmd);
  };
  const booking = calendarAction("r_one", { action: "book", start }, { ...f.options, command });
  await waiting;
  const stalePick = calendarAction("r_one", { action: "book", start: f.input.offered[1]!.start }, f.options);
  const rejected = assert.rejects(stalePick, /request is booked/);
  release();
  await booking;
  await rejected;
  assert.equal(f.calls.filter(c => c[2] === "update").length, 1);
  assert.equal(f.read().booked!.start, start);
});

test("an explicit Mac failure releases a pending update without deleting the old offer", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => cmd.argv[2] === "update" ? { handle: "denied-update" } : f.command(cmd);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, { ...f.options, command, poll: async () => ({ handle: "denied-update" }) }), /unresolved/);
  await assert.rejects(calendarAction("r_one", { action: "resume" }, { ...f.options, command, poll: async () => ({ error: "denied" }) }), /previous offer retained/);
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.deepEqual(f.read().offered, f.input.offered);
  assert.ok(f.calls.every(c => c[2] !== "delete"));
});

test("calendar reads reuse the wrapped and note-prefixed event parser", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => {
    const result = await f.command(cmd);
    return "output" in result && ["events", "event"].includes(cmd.argv[2]!)
      ? { output: JSON.stringify({ exit_code: 0, output: `Note: calendar output\n${result.output}` }) } : result;
  };
  await calendarAction("r_one", { action: "book", start }, { ...f.options, command });
  assert.equal(f.read().status, "booked");
});

for (const failure of ["offline", "degraded", "truncated"]) test(`an owner offer with ${failure} calendar coverage drops an unsent provisional request`, async t => {
  const f = fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [] });
  const calls: string[][] = [];
  const command = async (cmd: MacCommand): Promise<MacOutcome | undefined> => {
    calls.push(cmd.argv);
    if (failure === "offline") return undefined;
    return { output: JSON.stringify({ events: [], ...(failure === "degraded" ? { degraded: [account] } : { truncated: { after: start } }) }) };
  };
  await assert.rejects(offerRequest(f.offer, { ...f.options, command }), /new request dropped/);
  assert.equal(f.read().status, "dropped");
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.ok(calls.length > 0 && calls.every(c => c[2] === "events"), "no calendar write was sent");
});

test("an offline preflight after a hold was created keeps the journal for recovery", async t => {
  const f = fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [] });
  f.events.clear();
  const command = async (cmd: MacCommand) => cmd.argv[2] === "events" && f.events.size ? undefined : f.command(cmd);
  await assert.rejects(offerRequest(f.offer, { ...f.options, command }), /calendar unavailable/);
  assert.equal(f.read().status, "offered");
  assert.equal(pendingCalendarWrites().length, 1);
  await calendarAction(f.read().id, { action: "resume" }, f.options);
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.equal(f.calls.filter(c => c[2] === "create").length, 2);
});

test("booked replacement holds preserve the event, expire independently and clean up after a move", async t => {
  const f = fixture(t, "chat-one");
  await calendarAction("r_one", { action: "book", start }, f.options);
  const booked = f.read().booked;
  const replacement = { ...f.offer, offered: [
    { start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:30:00Z", account },
    { start: "2026-10-06T12:00:00Z", end: "2026-10-06T12:30:00Z", account },
  ] };
  await calendarAction("r_one", { action: "offer", request: replacement }, f.options);
  assert.equal(f.read().status, "booked");
  assert.deepEqual(f.read().booked, booked);
  assert.equal(f.events.get("hold-one")!.start.dateTime, start);
  const early = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 47 * 3600_000 });
  assert.equal(early.skipped, true, "expiry uses the replacement timestamp, not the original offer");
  assert.equal(early.groupNotice, undefined);
  const expired = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 49 * 3600_000 });
  assert.equal(expired.request.status, "booked");
  assert.equal(expired.request.reoffer, undefined);
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.equal(f.events.get("new-1")!.status, "cancelled");
  assert.equal(f.events.get("new-2")!.status, "cancelled");
  assert.equal(expired.groupNotice?.chatUid, "chat-one");
  assert.match(expired.groupNotice?.text ?? "", /replacement times were released.*booking.*unchanged/i);
  t.diagnostic(`Group expiry notice: ${expired.groupNotice?.text}`);
  const again = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 49 * 3600_000 });
  assert.equal(again.skipped, true);
  assert.equal(again.groupNotice, undefined);
  await calendarAction("r_one", { action: "offer", request: replacement }, f.options);
  await calendarAction("r_one", { action: "book", start: replacement.offered[0]!.start }, f.options);
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(f.read().booked!.start, replacement.offered[0]!.start);
  assert.equal(f.read().reoffer, undefined);
  assert.equal(f.events.get("new-3")!.status, "cancelled");
  assert.equal(f.events.get("new-4")!.status, "cancelled");
  assert.ok(f.calls.filter(c => c[2] === "delete").every(c => c[4] !== "hold-one"));
  assert.ok(f.calls.filter(c => c[2] === "update").every(c => c[c.indexOf("--send-updates") + 1] === "all"));
});

test("moving an externally cancelled booked event refuses to create another invitation", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  f.events.get("hold-one")!.status = "cancelled";
  const before = f.read();
  await assert.rejects(calendarAction("r_one", { action: "book", start: "2026-10-06T11:00:00Z" }, f.options), /booked event was cancelled/);
  assert.deepEqual(f.read(), before);
  assert.equal(f.calls.filter(c => c[2] === "create").length, 0);
});

for (const outcome of ["failure", "lost-response"] as const) test(`booked reoffers preserve the booking across ${outcome}`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  const original = f.read().booked;
  const input = { ...f.offer, offered: [{ start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:30:00Z", account }] };
  await calendarAction("r_one", { action: "offer", request: input }, f.options);
  const previous = f.read().reoffer;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "create") return f.command(cmd);
    if (outcome === "failure") return { error: "offline" };
    await f.command(cmd); return undefined;
  };
  const replacement = calendarAction("r_one", { action: "offer", request: input }, { ...f.options, command });
  if (outcome === "failure") {
    await assert.rejects(replacement, /previous offer retained/);
    assert.deepEqual(f.read().reoffer, previous);
    assert.equal(f.events.get("new-1")!.status, "confirmed");
  } else {
    await replacement;
    assert.equal(f.read().reoffer!.offered[0]!.holdId, "new-2");
    assert.equal(f.events.get("new-1")!.status, "cancelled");
  }
  assert.deepEqual(f.read().booked, original);
  assert.equal(f.read().status, "booked");
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
});

test("a reconciled move commits once and retains failed reoffer cleanup for retry", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  await calendarAction("r_one", { action: "offer", request: f.offer }, f.options);
  const before = f.read().booked;
  let moved = false;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "delete") return { error: "offline" };
    const result = await f.command(cmd);
    if (cmd.argv[2] === "update") { moved = true; return { handle: "move-pending" }; }
    return result;
  };
  const options = { ...f.options, command, poll: async () => ({ handle: "move-pending" }) };
  await assert.rejects(calendarAction("r_one", { action: "book", start: "2026-10-06T10:00:00Z" }, options), /approval is pending/);
  assert.equal(moved, true);
  assert.deepEqual(f.read().booked, before);
  assert.ok(f.read().reoffer);
  await calendarAction("r_one", { action: "resume" }, { ...options, poll: async () => ({ output: JSON.stringify(f.events.get("hold-one")) }) });
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(f.read().reoffer, undefined);
  assert.equal(f.read().holdCleanup!.length, 2);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.deepEqual(f.read().holdCleanup, []);
  assert.equal(f.calls.filter(c => c[2] === "update").length, 2, "one initial booking and one move");
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
});

test("format changes retain a live reoffer; cancel releases it and notifies only the booked invite", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  await calendarAction("r_one", { action: "offer", request: f.offer }, f.options);
  const replacement = f.read().reoffer;
  await calendarAction("r_one", { action: "format", format: "meet" }, f.options);
  assert.deepEqual(f.read().reoffer, replacement);
  assert.equal(f.events.get("new-1")!.status, "confirmed");
  assert.equal(f.events.get("new-2")!.status, "confirmed");
  await calendarAction("r_one", { action: "cancel" }, f.options);
  assert.equal(f.read().status, "dropped");
  assert.equal(f.read().reoffer, undefined);
  assert.deepEqual(f.read().holdCleanup, []);
  for (const id of ["hold-one", "new-1", "new-2"]) {
    assert.equal(f.events.get(id)!.status, "cancelled");
    const deletion = f.calls.find(c => c[2] === "delete" && c[4] === id)!;
    assert.equal(deletion[deletion.indexOf("--send-updates") + 1], id === "hold-one" ? "all" : "none");
  }
});

test("owner DM lookup and exact-time check select the booked record and move its event", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  const env = { MEETLY_HOME: f.home };
  const listed = cli("ledger.ts", ["booked"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.requests.length, 1);
  assert.equal(listed.json.requests[0].id, "r_one");
  const busyFile = join(f.home, "busy.json");
  writeJson(busyFile, { busy: [{ id: "hold-one", account, start, end }], degraded: [] });
  const checked = cli("slots.ts", ["--in", busyFile, "--request", "r_one", "--at", "2026-10-05T10:15:00Z", "--now", new Date(now).toISOString()], env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.free, true, "the original event is not a conflict with its own move");
  await calendarAction(listed.json.requests[0].id, { action: "book", start: checked.json.slot.start, end: checked.json.slot.end }, f.options);
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(Date.parse(f.read().booked!.start), Date.parse("2026-10-05T10:15:00Z"));
  t.diagnostic(`Mock owner DM flow: booked lookup → exact-time check → update ${f.read().eventId} at ${f.read().booked!.start}; no replacement event created.`);
});


test("a flagged owner offer requires explicit confirmation and retains the contact flag afterwards", async t => {
  const f = fixture(t);
  const path = join(f.home, "ledger.json");
  writeJson(path, setDoNotContact(readJson<Ledger>(path, { requests: [] }), f.input.handle, true, now));
  await assert.rejects(offerRequest(f.offer, f.options), /Confirm in the owner's DM/);
  assert.deepEqual(f.calls, [], "no calendar operation before confirmation");
  const result = await offerRequest(f.offer, { ...f.options, confirmContact: true });
  assert.equal(result.request.doNotContact, true);
  assert.ok(f.calls.some(c => c[2] === "create"));
});

for (const collision of [false, true]) test(`overlap approval applies only to its account (collision=${collision})`, async t => {
  const f = fixture(t);
  const configFile = join(f.home, "config.json");
  const config = readJson<any>(configFile, {});
  if (collision) config.calendars.push({ account: "other@example.com", id: "primary" });
  writeJson(configFile, config);
  const command = async (cmd: MacCommand) => cmd.argv[2] === "events"
    ? { output: JSON.stringify({ events: [calendarEvent("same-id", start, end)] }) } : f.command(cmd);
  const action = offerRequest({ ...f.offer, offered: f.offer.offered.slice(0, 1),
    allowOverlap: [{ account, id: "same-id" }] }, { ...f.options, command });
  if (collision) {
    await assert.rejects(action);
    assert.equal(f.calls.filter(c => c[2] === "create").length, 0);
  } else {
    await action;
    assert.equal(f.calls.filter(c => c[2] === "create").length, 1);
  }
});

for (const [meal, supplied, expected] of [["lunch", 30, 60], ["dinner", 30, 60], ["coffee", 60, 30]] as const)
test(`a ${meal} offer ignores model duration in both the ledger and calendar hold`, async t => {
  const f = fixture(t);
  const { request } = await offerRequest({ ...f.offer, meal, durationMin: supplied,
    offered: [{ start, end: new Date(Date.parse(start) + supplied * 60_000).toISOString() }],
  }, f.options);
  assert.equal(request.durationMin, expected);
  const slot = request.offered[0]!;
  assert.equal(Date.parse(slot.end) - Date.parse(slot.start), expected * 60_000);
  const hold = f.events.get(slot.holdId!)!;
  assert.equal(Date.parse(hold.end.dateTime) - Date.parse(hold.start.dateTime), expected * 60_000);
});

test("a meal offer checks conflicts for its full default duration", async t => {
  const f = fixture(t);
  f.events.set("later-conflict", calendarEvent("later-conflict", "2026-10-05T10:45:00Z", "2026-10-05T11:00:00Z"));
  await assert.rejects(offerRequest({ ...f.offer, meal: "lunch", durationMin: 30,
    offered: [{ start, end }],
  }, f.options));
  assert.equal(f.calls.some(c => c[2] === "create"), false);
  assert.deepEqual(f.read().offered, f.input.offered);
});
