import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { calendarAction, offerRequest, pendingCalendarWrites, resumePending, type CalendarOptions } from "../skills/meetly/scripts/calendar.ts";
import { addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { macOutcome, type MacCommand, type MacOutcome } from "../skills/meetly/scripts/mac.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, fakeCalendar, cli, tmpHome } from "./helpers.ts";

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

for (const key of ["allowOverlap", "allowOverlapTitles"]) test(`raw offer rejects ${key} before any ledger mutation`, t => {
  const f = fixture(t), before = f.read();
  const result = cli("calendar.ts", ["offer", "--json", JSON.stringify({ ...f.offer, [key]: [] })], { MEETLY_HOME: f.home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner.*DM/i);
  assert.deepEqual(f.read(), before);
});

test("raw duration patches cannot race a calendar booking", t => {
  const f = fixture(t), before = f.read();
  const result = cli("ledger.ts", ["update", "--id", "r_one", "--json", '{"durationMin":60,"topic":"Hour"}'], { MEETLY_HOME: f.home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed by calendar/);
  assert.deepEqual(f.read(), before);
});

for (const bookFirst of [true, false]) test(`duration replacement serializes with booking (book first: ${bookFirst})`, async t => {
  const f = fixture(t);
  const replacement = { action: "duration" as const, durationMin: 60, topic: "Hour",
    offered: [{ start, end: "2026-10-05T11:00:00Z" }] };
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === (bookFirst ? "update" : "create")) { entered(); await gate; }
    return f.command(cmd);
  };
  const first = calendarAction("r_one", bookFirst ? { action: "book", start } : replacement, { ...f.options, command });
  await waiting;
  const second = calendarAction("r_one", bookFirst ? replacement : { action: "book", start }, f.options);
  const checked = bookFirst ? assert.rejects(second, /request is booked/) : second;
  assert.equal(f.read().durationMin, 30);
  assert.equal(f.read().topic, "Lunch");
  assert.deepEqual(f.read().offered, f.input.offered);
  release();
  await first;
  await checked;
  assert.equal(f.read().durationMin, bookFirst ? 30 : 60);
  assert.equal(f.read().topic, bookFirst ? "Lunch" : "Hour");
  assert.equal(Date.parse(f.read().booked!.end) - Date.parse(f.read().booked!.start), f.read().durationMin * 60_000);
  assert.equal(f.events.get("hold-two")!.status, "cancelled");
});

test("failed duration replacement retains the old duration, topic and holds", async t => {
  const f = fixture(t), before = f.read();
  await assert.rejects(calendarAction("r_one", { action: "duration", durationMin: 60, topic: "Hour",
    offered: [{ start, end: "2026-10-05T11:00:00Z" }] }, { ...f.options,
    command: async cmd => cmd.argv[2] === "create" ? { error: "refused" } : f.command(cmd) }), /previous offer retained/);
  assert.equal(f.read().durationMin, before.durationMin);
  assert.equal(f.read().topic, before.topic);
  assert.deepEqual(f.read().offered, before.offered);
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
});

test("raw ledger mutations cannot bypass DM overlap authorization", t => {
  const f = fixture(t), before = f.read();
  for (const action of ["add", "save", "update"]) {
    const args = action === "update" ? {} : { ...f.offer, handle: "+15557654321" };
    const result = cli("ledger.ts", [action, "--id", "r_one", "--json",
      JSON.stringify({ ...args, allowOverlap: [{ account, id: "busy" }] })], { MEETLY_HOME: f.home });
    assert.equal(result.status, 1, action);
    assert.match(result.stderr, /owner DM|managed by calendar/);
    assert.deepEqual(f.read(), before);
  }
});

for (const durationMin of [15, 60]) test(`offer rejects intervals that differ from request duration ${durationMin}`, async t => {
  const f = fixture(t), before = f.read();
  await assert.rejects(offerRequest({ ...f.offer, durationMin }, f.options), /interval.*duration/i);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.calls, []);
});

test("an unsaved offer without duration must ask the model to set it", async t => {
  const f = fixture(t);
  writeJson(join(f.home, "ledger.json"), { requests: [] });
  const { durationMin, ...offer } = f.offer;
  await assert.rejects(offerRequest(offer, f.options), /set.*durationMin/i);
  assert.deepEqual(readJson(join(f.home, "ledger.json"), {}), { requests: [] });
  assert.deepEqual(f.calls, []);
});

test("an offer uses saved duration rather than the configured duration", async t => {
  const f = fixture(t), { durationMin, ...offer } = f.offer;
  const saved = f.read();
  saved.durationMin = 45;
  writeJson(join(f.home, "ledger.json"), { requests: [saved] });
  const { request } = await offerRequest({ ...offer, offered: [{ start, end: "2026-10-05T10:45:00Z" }] }, f.options);
  assert.equal(request.durationMin, 45);
});

test("an offer waiting for the lock cannot overwrite a newer saved duration", async t => {
  const f = fixture(t), { durationMin, ...offer } = f.offer;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "create") { entered(); await gate; }
    return f.command(cmd);
  };
  const change = calendarAction("r_one", { action: "duration", durationMin: 60, topic: "Hour",
    offered: [{ start, end: "2026-10-05T11:00:00Z" }] }, { ...f.options, command });
  await waiting;
  const stale = assert.rejects(offerRequest(offer, f.options), /duration changed/);
  release();
  await change;
  await stale;
  assert.equal(f.read().durationMin, 60);
  assert.equal(f.read().offered[0]!.end, "2026-10-05T11:00:00Z");
  assert.equal(f.calls.filter(cmd => cmd[2] === "create").length, 1);
});
