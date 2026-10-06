import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { confirmContactOffer } from "../skills/meetly/scripts/contact-policy.ts";
import { approveTime, calendarAction, calendarCommand, offerRequest, pendingCalendarWrites, resumePending, type CalendarOptions } from "../skills/meetly/scripts/calendar.ts";
import { doNotContact, setDoNotContact, addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
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
  const input = { travel: { beforeMin: 0, afterMin: 0 }, origin: "owner" as const, handle: "+15551234567", name: "Guest", chatUid, topic: "Lunch", durationMin: 30, offered };
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, input, now - 72 * 3_600_000, "r_one"));
  writeJson(join(home, "config.json"), { ...DEFAULTS, defaultAccount: account, timezone: "UTC", ownerName: "Alex", setupDoneAt: new Date(now).toISOString(), calendars: [{account, id: account}] });
  const { events, calls, command } = fakeCalendar(offered.map(o => calendarEvent(o.holdId, o.start, o.end)));
  const path = join(home, "ledger.json");
  const read = () => readJson<Ledger>(path, { requests: [] }).requests[0]!;
  const blockContact = (at = now) => writeJson(path, setDoNotContact(readJson<Ledger>(path, { requests: [] }), input.handle, true, at));
  return { home, path, blockContact, input, offer: { ...input, offered: offered.map(({ holdId, ...slot }) => slot) }, read, calls, events, command, options: { command, now: () => now } satisfies CalendarOptions };
}

for (const path of ["raw", "duration"] as const) test(`four-slot ${path} offer is rejected before calendar or ledger effects`, async t => {
  const f = fixture(t);
  const before = fs.readFileSync(join(f.home, "ledger.json"), "utf8");
  const offered = Array.from({ length: 4 }, (_, i) => ({
    start: `2026-10-0${5 + i}T10:00:00Z`, end: `2026-10-0${5 + i}T10:30:00Z`, account,
  }));
  const action = path === "duration"
    ? calendarAction("r_one", { action: "duration", durationMin: 30, topic: "Call", offered }, f.options)
    : offerRequest({ ...f.offer, offered }, f.options);
  await assert.rejects(action, /at most 3/i);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(join(f.home, "ledger.json"), "utf8"), before);
  assert.deepEqual(pendingCalendarWrites(), []);
});

test("fractional-minute resize is rejected before any calendar read or write", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  const before = f.read();
  f.calls.length = 0;
  await assert.rejects(calendarAction("r_one", { action: "book", start, end: "2026-10-05T10:30:30Z" }, f.options));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.read(), before);
});

for (const status of ["offered", "booked"] as const) for (const location of [undefined, "Cafe"]) test(`a ${status} format change ${location === undefined ? "clears an omitted" : "keeps an explicit"} location`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", travel: { beforeMin: 15, afterMin: 15 }, location: "Library" }, f.options);
  if (status === "booked") await calendarAction("r_one", { action: "book", start }, f.options);
  if (status === "offered") {
    const changed = cli("calendar.ts", ["format", "--id", "r_one", "--json", JSON.stringify({ format: "meet", travel: { beforeMin: 0, afterMin: 0 }, location })], { MEETLY_HOME: f.home });
    assert.equal(changed.status, 0, changed.stderr);
  } else await calendarAction("r_one", { action: "format", format: "meet", travel: { beforeMin: 0, afterMin: 0 }, location }, f.options);
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

for (const revoked of [false, true]) test(`a ledger commit failure after the calendar update resumes without repeating the write: revoked=${revoked}`, async t => {
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
  if (revoked) f.blockContact();
  await calendarAction("r_one", { action: "resume" }, f.options);
  assert.equal(f.read().status, "booked");
  assert.equal(doNotContact(readJson<Ledger>(f.path, { requests: [] }), f.input.handle), revoked);
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

test("a new offer uses the owner's configured duration when none is supplied", async t => {
  const f = fixture(t), { durationMin, ...offer } = f.offer;
  writeJson(join(f.home, "ledger.json"), { requests: [] });
  const config = readJson<any>(join(f.home, "config.json"), {});
  writeJson(join(f.home, "config.json"), { ...config, durationMin: 45 });
  f.events.clear();
  const { request } = await offerRequest({ ...offer, offered: [{ start, end: "2026-10-05T10:45:00Z" }] }, f.options);
  assert.equal(request.durationMin, 45);
  assert.equal(Date.parse(request.offered[0]!.end) - Date.parse(request.offered[0]!.start), 45 * 60_000);
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

for (const approval of [false, true]) test(`pending approval does not change explicit booking mode: timeApproval=${approval}`, async t => {
  const f = fixture(t);
  const ledger = readJson<Ledger>(join(f.home, "ledger.json"), { requests: [] });
  ledger.requests[0]!.pendingOwner = { askedAt: new Date(now).toISOString(), start, end };
  ledger.requests[0]!.allowOverlap = [{ account, id: "conflict" }];
  writeJson(join(f.home, "ledger.json"), ledger);
  f.events.set("conflict", calendarEvent("conflict", start, end));
  if (approval) {
    const result = await approveTime("r_one", {}, f.options);
    assert.equal("approved" in result && result.approved, false);
    assert.equal("code" in result && result.code, "TIME_APPROVAL_BUSY");
    assert.equal(f.read().status, "offered");
    assert.ok(f.read().pendingOwner);
    assert.equal(f.calls.some(c => ["create", "update"].includes(c[2]!)), false);
  } else {
    const result = await calendarAction("r_one", { action: "book", start }, f.options);
    assert.equal(result.request.status, "booked");
    assert.deepEqual(result.request.allowOverlap, []);
  }
});

for (const busy of [false, true]) test(`time approval without a pending ask ${busy ? "refuses busy time" : "books a free time"}`, async t => {
  const f = fixture(t);
  const approvedStart = "2026-10-05T20:00:00Z", approvedEnd = "2026-10-05T20:30:00Z";
  const ledger = readJson<Ledger>(join(f.home, "ledger.json"), { requests: [] });
  ledger.requests[0]!.allowOverlap = [{ account, id: "conflict" }];
  writeJson(join(f.home, "ledger.json"), ledger);
  if (busy) f.events.set("conflict", calendarEvent("conflict", approvedStart, approvedEnd));
  const result = await approveTime("r_one", { start: approvedStart }, f.options);
  assert.equal("approved" in result && result.approved, !busy);
  if (busy) {
    assert.equal("code" in result && result.code, "TIME_APPROVAL_BUSY");
    assert.equal("near" in result && Date.parse(result.near!), Date.parse(approvedStart));
    assert.equal(f.read().status, "offered");
    assert.deepEqual(f.read().offered, f.input.offered);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CALENDAR TITLE/);
  } else {
    assert.equal(f.read().status, "booked");
    assert.equal(Date.parse(f.read().booked!.end), Date.parse(approvedEnd));
  }
  t.diagnostic(JSON.stringify({ approved: "approved" in result && result.approved, ...("code" in result ? { code: result.code, near: result.near, recovery: result.recovery } : {}) }));
});

test("a time approval reports a conflict that appears after its calendar read", async t => {
  const f = fixture(t);
  const command = async (cmd: MacCommand) => cmd.argv[2] === "update"
    ? { error: "Calendar slot is busy", code: "calendar-conflict" as const } : f.command(cmd);
  const result = await approveTime("r_one", { start }, { ...f.options, command });
  assert.equal("approved" in result && result.approved, false);
  assert.equal("code" in result && result.code, "TIME_APPROVAL_BUSY");
  assert.equal(f.read().status, "offered");
  assert.deepEqual(pendingCalendarWrites(), []);
});


test("a time approval never sends a conflict override even across its own hold", async t => {
  const f = fixture(t);
  const writes: string[][] = [];
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "create") return f.command(cmd);
    writes.push(cmd.argv);
    return { error: "Calendar slot is busy", code: "calendar-conflict" as const };
  };
  const result = await approveTime("r_one", { start: "2026-10-05T10:15:00Z" }, { ...f.options, command });
  assert.equal("approved" in result && result.approved, false);
  assert.equal(writes.length, 1);
  assert.equal(writes.some(c => c.includes("--confirm-conflict")), false);
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
  assert.equal(f.read().bookedReplacement, true);
  assert.deepEqual(f.read().booked, booked);
  assert.equal(f.events.get("hold-one")!.start.dateTime, start);
  const early = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 47 * 3600_000 });
  assert.ok(!("error" in early));
  assert.equal(early.skipped, true, "expiry uses the replacement timestamp, not the original offer");
  assert.equal(early.groupNotice, undefined);
  const expired = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 49 * 3600_000 });
  assert.ok(!("error" in expired));
  assert.equal(expired.request.status, "booked");
  assert.deepEqual(expired.request.offered, []);
  assert.equal(expired.request.bookedReplacement, false);
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.equal(f.events.get("new-1")!.status, "cancelled");
  assert.equal(f.events.get("new-2")!.status, "cancelled");
  assert.equal(expired.groupNotice?.chatUid, "chat-one");
  assert.match(expired.groupNotice?.text ?? "", /replacement times were released.*booking.*unchanged/i);
  t.diagnostic(`Group expiry notice: ${expired.groupNotice?.text}`);
  const again = await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 49 * 3600_000 });
  assert.ok(!("error" in again));
  assert.equal(again.skipped, true);
  assert.equal(again.groupNotice, undefined);
  await calendarAction("r_one", { action: "offer", request: replacement }, f.options);
  await calendarAction("r_one", { action: "book", start: replacement.offered[0]!.start }, f.options);
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(f.read().booked!.start, replacement.offered[0]!.start);
  assert.deepEqual(f.read().offered, []);
  assert.equal(f.read().bookedReplacement, false);
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
  const previous = f.read().offered;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "create") return f.command(cmd);
    if (outcome === "failure") return { error: "offline" };
    await f.command(cmd); return undefined;
  };
  const replacement = calendarAction("r_one", { action: "offer", request: input }, { ...f.options, command });
  if (outcome === "failure") {
    await assert.rejects(replacement, /previous offer retained/);
    assert.deepEqual(f.read().offered, previous);
    assert.equal(f.events.get("new-1")!.status, "confirmed");
  } else {
    await replacement;
    assert.equal(f.read().offered[0]!.holdId, "new-2");
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
  assert.ok(f.read().offered.length);
  await calendarAction("r_one", { action: "resume" }, { ...options, poll: async () => ({ output: JSON.stringify(f.events.get("hold-one")) }) });
  assert.equal(f.read().eventId, "hold-one");
  assert.deepEqual(f.read().offered, []);
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
  const replacement = f.read().offered;
  assert.equal(f.read().bookedReplacement, true);
  await calendarAction("r_one", { action: "format", format: "meet", travel: { beforeMin: 0, afterMin: 0 } }, f.options);
  assert.deepEqual(f.read().offered, replacement);
  assert.equal(f.read().bookedReplacement, true);
  assert.equal(f.events.get("new-1")!.status, "confirmed");
  assert.equal(f.events.get("new-2")!.status, "confirmed");
  await calendarAction("r_one", { action: "cancel" }, f.options);
  assert.equal(f.read().status, "dropped");
  assert.equal(f.read().bookedReplacement, false);
  assert.deepEqual(f.read().offered, []);
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
  writeJson(busyFile, { busy: [{ id: "hold-one", account, start, end }], degraded: [],
    coverage: { from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z" } });
  const checked = cli("slots.ts", ["--in", busyFile, "--request", "r_one", "--at", "2026-10-05T10:15:00Z", "--now", new Date(now).toISOString()], env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.free, true, "the original event is not a conflict with its own move");
  await calendarAction(listed.json.requests[0].id, { action: "book", start: checked.json.slot.start, end: checked.json.slot.end }, f.options);
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(Date.parse(f.read().booked!.start), Date.parse("2026-10-05T10:15:00Z"));
  t.diagnostic(`Mock owner DM flow: booked lookup → exact-time check → update ${f.read().eventId} at ${f.read().booked!.start}; no replacement event created.`);
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

test("a flagged owner offer requires explicit confirmation and retains the contact flag afterwards", async t => {
  const f = fixture(t);
  f.blockContact();
  await assert.rejects(offerRequest(f.offer, f.options), /Confirm in the owner's DM/);
  assert.deepEqual(f.calls, [], "no calendar operation before confirmation");
  const result = await confirmContactOffer({ requestId: "r_one", offered: f.offer.offered }, f.options);
  assert.equal(result.request.contactApproved, true);
  assert.equal(doNotContact(readJson<Ledger>(f.path, { requests: [] }), f.input.handle), true);
  assert.ok(f.calls.some(c => c[2] === "create"));
  await calendarAction("r_one", { action: "book", start }, f.options);
  assert.equal(f.read().status, "booked");
  f.blockContact();
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /Confirm in the owner's DM/);
});

test("booking consumes overlap permission before any later move", async t => {
  const f = fixture(t, "chat-one");
  f.events.set("private", calendarEvent("private", start, "2026-10-05T12:00:00Z"));
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), allowOverlap: [{ account, id: "private" }] }] });
  await calendarAction("r_one", { action: "book", start }, f.options);
  assert.deepEqual(f.read().allowOverlap, []);
  await assert.rejects(calendarAction("r_one", { action: "book", start: "2026-10-05T11:00:00Z", end: "2026-10-05T11:30:00Z" }, f.options));
  assert.equal(Date.parse(f.read().booked!.start), Date.parse(start));
});

test("a booked replacement cannot reuse a legacy overlap grant", async t => {
  const f = fixture(t, "chat-one");
  await calendarAction("r_one", { action: "book", start }, f.options);
  const allowOverlap = [{ account, id: "private" }];
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), allowOverlap }] });
  const replacement = { start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", account };
  f.events.set("private", calendarEvent("private", replacement.start, replacement.end));
  const creates = f.calls.filter(c => c[2] === "create").length;
  await assert.rejects(calendarAction("r_one", { action: "offer", request: { ...f.offer, allowOverlap, offered: [replacement] } }, f.options));
  assert.equal(f.calls.filter(c => c[2] === "create").length, creates);
  assert.equal(Date.parse(f.read().booked!.start), Date.parse(start));
});

test("an owner replacement commits revised conditions on the booked request", async t => {
  const f = fixture(t, "chat-one");
  const constraints = { from: "2026-10-05", to: "2026-10-05" };
  writeJson(join(f.home, "ledger.json"), { requests: [{ ...f.read(), constraints }] });
  await calendarAction("r_one", { action: "book", start }, f.options);
  const booked = f.read().booked;
  const revised = { from: "2026-10-07", to: "2026-10-07" };
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, constraints: revised,
    offered: [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", account }] } }, f.options);
  assert.deepEqual(f.read().constraints, revised);
  assert.deepEqual(f.read().booked, booked);
  assert.equal(readJson<Ledger>(join(f.home, "ledger.json"), { requests: [] }).requests.length, 1);
});

for (const action of ["offer", "duration", "book", "approve-time"] as const) test(`contact policy blocks direct ${action} before calendar effects`, async t => {
  const f = fixture(t);
  f.blockContact();
  const before = fs.readFileSync(f.path, "utf8");
  const input = action === "offer" ? { action, request: f.offer }
    : action === "duration" ? { action, durationMin: 30, topic: "Call", offered: f.offer.offered }
    : { action, start };
  await assert.rejects(calendarAction("r_one", input, f.options), /Confirm in the owner's DM/);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.path, "utf8"), before);
  await calendarAction("r_one", { action: "cancel" }, f.options);
  assert.equal(f.read().status, "dropped", "contact policy must leave cancellation reachable");
});

test("failed contact confirmation cannot authorize the previous offer", async t => {
  const f = fixture(t, "chat-one");
  f.blockContact();
  const proposed = [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z" }];
  await assert.rejects(confirmContactOffer({ requestId: "r_one", offered: proposed }, { ...f.options,
    command: async command => command.argv[2] === "create" ? { error: "failed" } : f.command(command),
  }));
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /Confirm in the owner's DM/);
  assert.equal(f.read().contactApproved, undefined);
  assert.ok(f.read().pendingOwner && "contact" in f.read().pendingOwner!);
  assert.equal(f.read().status, "offered");
  await confirmContactOffer({ requestId: "r_one", offered: proposed }, f.options);
  assert.equal(f.read().pendingOwner, undefined);
  await calendarAction("r_one", { action: "book", start: proposed[0]!.start }, f.options);
  assert.equal(f.read().status, "booked");
});

for (const response of ["success", "lost", "pending"] as const) test(`contact revocation reconciles a sent booking update: ${response}`, async t => {
  const f = fixture(t);
  let sent!: MacCommand, writes = 0;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] !== "update") return f.command(cmd);
    sent = cmd; writes++;
    f.blockContact();
    if (response === "pending") return undefined;
    const result = await f.command(cmd);
    return response === "lost" ? undefined : result;
  };
  const options = { ...f.options, command };
  const booking = calendarAction("r_one", { action: "book", start }, options);
  if (response === "pending") {
    await assert.rejects(booking, /unresolved/);
    await assert.rejects(calendarAction("r_one", { action: "resume" }, options), /unresolved/);
    assert.deepEqual(pendingCalendarWrites(), ["r_one"]);
    await assert.rejects(calendarAction("r_one", { action: "expire" }, options), /unresolved/);
    assert.ok(f.calls.every(c => c[2] !== "delete"));
    await f.command(sent);
    await calendarAction("r_one", { action: "resume" }, options);
  } else await booking;
  assert.equal(f.read().status, "booked");
  assert.equal(f.read().eventId, "hold-one");
  assert.equal(f.read().contactApproved, undefined);
  assert.equal(doNotContact(readJson<Ledger>(f.path, { requests: [] }), f.input.handle), true);
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.equal(writes, 1);
  await calendarAction("r_one", { action: "expire" }, options);
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.equal(f.events.get("hold-two")!.status, "cancelled");
  await assert.rejects(calendarAction("r_one", { action: "book", start }, options), /Confirm in the owner's DM/);
});

for (const revokeAt of ["unresolved", "availability", "last-create"] as const) test(`contact revocation wins at ${revokeAt} and cleans the replacement`, async t => {
  const f = fixture(t, "chat-one");
  const revoke = () => f.blockContact(now + 1);
  revoke();
  const proposed = [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z" }];
  let revoked = false;
  const command: CalendarOptions["command"] = async cmd => {
    if (revokeAt === "availability" && cmd.argv[2] === "events" && !revoked) { revoke(); revoked = true; }
    const result = await f.command(cmd);
    if (cmd.argv[2] === "create") {
      if (revokeAt === "last-create") revoke();
      if (revokeAt === "unresolved") return undefined;
    }
    if (revokeAt === "unresolved" && cmd.argv.includes("--private-prop-filter")) return { output: '{"events":[]}' };
    return result;
  };
  await assert.rejects(confirmContactOffer({ requestId: "r_one", offered: proposed }, { ...f.options, command }));
  if (revokeAt === "unresolved") {
    revoke();
    await assert.rejects(calendarAction("r_one", { action: "resume" }, f.options), /Confirm in the owner's DM/);
  }
  assert.deepEqual(pendingCalendarWrites(), []);
  assert.deepEqual(f.read().offered, f.input.offered);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /Confirm in the owner's DM/);
  assert.ok([...f.events.values()].filter(e => e.id.startsWith("new-")).every(e => e.status === "cancelled"));
  if (revokeAt === "availability") assert.equal(f.calls.filter(c => c[2] === "create").length, 0);
});

test("time approval uses the duration committed while it waits for the calendar lock", async t => {
  const f = fixture(t);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const replacement = calendarAction("r_one", { action: "duration", durationMin: 60, topic: "Hour",
    offered: [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T11:00:00Z" }] }, { ...f.options,
    command: async cmd => { if (cmd.argv[2] === "create") { entered(); await gate; } return f.command(cmd); } });
  await waiting;
  const approval = approveTime("r_one", { start }, f.options);
  release();
  await replacement;
  const result = await approval;
  assert.equal("approved" in result && result.approved, true);
  assert.equal(f.read().durationMin, 60);
  assert.equal(Date.parse(f.read().booked!.end) - Date.parse(f.read().booked!.start), 60 * 60_000);
  t.diagnostic(JSON.stringify({ durationMin: f.read().durationMin, booked: f.read().booked }));
});

for (const outcome of ["busy", "success"] as const) for (const batch of [false, true]) test(`deferred time approval resumes with ${outcome}: batch=${batch}`, async t => {
  const f = fixture(t);
  let completed: Awaited<ReturnType<typeof f.command>>;
  const options = { ...f.options,
    command: async (cmd: MacCommand) => {
      if (cmd.argv[2] !== "update") return f.command(cmd);
      if (outcome === "success") completed = await f.command(cmd);
      return { handle: "approval" };
    }, poll: async () => ({ handle: "approval" }) };
  await assert.rejects(approveTime("r_one", { start }, options), /unresolved/);
  const journal = join(f.home, "calendar/r_one.json");
  const intent = readJson(journal, {});
  const resumed = { ...options, poll: async () => outcome === "success" ? completed
    : { error: "PRIVATE CONFLICT DETAILS", code: "calendar-conflict" as const } };
  const resume = async () => batch ? (await resumePending(resumed)).results[0]! : calendarAction("r_one", { action: "resume" }, resumed);
  const result = await resume();
  assert.equal("approved" in result && result.approved, outcome === "success");
  assert.equal(f.read().status, outcome === "success" ? "booked" : "offered");
  assert.deepEqual(pendingCalendarWrites(), []);
  t.diagnostic(JSON.stringify(result));
  if (outcome === "busy") {
    assert.equal("code" in result && result.code, "TIME_APPROVAL_BUSY");
    assert.equal("near" in result && Date.parse(result.near as string), Date.parse(start));
    assert.deepEqual("recovery" in result && result.recovery, { action: "find_nearest", allowOverlap: false });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONFLICT/);
  } else {
    writeJson(journal, intent);
    const recovered = await resume();
    assert.equal("approved" in recovered && recovered.approved, true);
    assert.deepEqual(pendingCalendarWrites(), []);
    t.diagnostic(JSON.stringify({ recovered }));
  }
});

test("booked replacement expiry clears its overlap grant", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start }, f.options);
  const booked = f.read().booked;
  const allowOverlap = [{ account, id: "private-conflict" }];
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, allowOverlap } }, { ...f.options, overlapApproved: true });
  assert.deepEqual(f.read().allowOverlap, allowOverlap);
  await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 49 * 3600_000 });
  assert.deepEqual(f.read().allowOverlap, []);
  assert.deepEqual(f.read().booked, booked);
});


test("contact confirmation can replace a booked offer without changing its decision snapshot", async t => {
  const f = fixture(t, "chat-one");
  await calendarAction("r_one", { action: "book", start }, f.options);
  const booked = f.read().booked;
  f.blockContact();
  const proposed = [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z" }];
  await confirmContactOffer({ requestId: "r_one", offered: proposed }, f.options);
  assert.equal(f.read().pendingOwner, undefined);
  assert.equal(f.read().contactApproved, true);
  assert.deepEqual(f.read().booked, booked);
  assert.equal(f.read().offered[0]!.start, proposed[0]!.start);
});

const travel = { beforeMin: 25, afterMin: 20 };

test("travel only creates private busy children on booking, then moves, resizes and cancels through the seam", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, format: "in_person", location: "Tartine", travel } }, f.options);
  assert.equal(f.calls.filter(c => c[2] === "create").length, 2, "offered holds have no travel events");
  const result = await calendarAction("r_one", { action: "book", start, attendees: "guest@example.com" }, f.options);
  assert.match(("ownerTravelNote" in result && result.ownerTravelNote) || "", /25 min travel before and 20 min after.*Tartine/);
  const children = f.read().travelEvents!;
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(c => f.events.get(c.holdId)!.start.dateTime), ["2026-10-05T09:35:00.000Z", end]);
  const creates = f.calls.filter(c => c[2] === "create" && c.includes("--visibility"));
  for (const command of creates) {
    assert.equal(command[command.indexOf("--visibility") + 1], "private");
    assert.equal(command[command.indexOf("--transparency") + 1], "opaque");
    assert.equal(command[command.indexOf("--send-updates") + 1], "none");
    assert.ok(command.includes("meetlyRequest=r_one"));
    assert.ok(!command.includes("--attendees"));
  }
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, travel, offered: [{ start: "2026-10-05T10:30:00Z", end: "2026-10-05T11:00:00Z", account }] } }, f.options);
  assert.deepEqual(f.read().travelEvents, children, "replacement holds keep booked travel");
  await calendarAction("r_one", { action: "book", start: "2026-10-05T10:30:00Z" }, f.options);
  assert.ok(children.every(c => f.events.get(c.holdId)!.status === "cancelled"));
  assert.equal(f.read().travelEvents!.length, 2);
  assert.equal(f.events.get(f.read().travelEvents![0]!.holdId)!.start.dateTime, "2026-10-05T10:05:00.000Z");
  await calendarAction("r_one", { action: "travel", travel: { beforeMin: 45, afterMin: 45, override: true } }, f.options);
  assert.equal(f.events.get(f.read().travelEvents![0]!.holdId)!.start.dateTime, "2026-10-05T09:45:00.000Z");
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Cafe", travel }, f.options);
  assert.deepEqual(f.read().travel, { beforeMin: 45, afterMin: 45, override: true });
  await calendarAction("r_one", { action: "cancel" }, f.options);
  assert.ok([...f.events.values()].every(e => e.status === "cancelled"));
  for (const command of f.calls.filter(c => c[2] === "delete" && c[4] !== f.read().eventId)) {
    assert.equal(command[command.indexOf("--send-updates") + 1], "none");
  }
});

for (const side of ["before", "after"] as const) test(`offers and picks recheck ${side} travel against other events`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Tartine", travel }, f.options);
  const event = side === "before" ? calendarEvent("busy", "2026-10-05T09:30:00Z", "2026-10-05T09:45:00Z")
    : calendarEvent("busy", "2026-10-05T10:40:00Z", "2026-10-05T11:00:00Z");
  f.events.set("busy", event);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /previous offer retained/);
  assert.equal(f.read().status, "offered");
  assert.equal(f.calls.filter(c => ["create", "update"].includes(c[2]!)).length, 0);
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, format: "in_person", travel } }, f.options);
  assert.equal(f.read().offered.length, 1);
  assert.equal(f.read().offered[0]!.start, f.offer.offered[1]!.start);
});

test("model estimates unknown-place meals at fifteen minutes; a named place resizes, virtual removes travel", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, meal: "lunch", travel: { beforeMin: 15, afterMin: 15 } } }, f.options);
  await calendarAction("r_one", { action: "book", start }, f.options);
  assert.equal(f.events.get(f.read().travelEvents![0]!.holdId)!.start.dateTime, "2026-10-05T09:45:00.000Z");
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Tartine", travel }, f.options);
  assert.equal(f.events.get(f.read().travelEvents![0]!.holdId)!.start.dateTime, "2026-10-05T09:35:00.000Z");
  const children = f.read().travelEvents!;
  await calendarAction("r_one", { action: "travel", travel: { beforeMin: 45, afterMin: 45, override: true } }, f.options);
  await calendarAction("r_one", { action: "format", format: "meet", travel: { beforeMin: 0, afterMin: 0 } }, f.options);
  assert.deepEqual(f.read().travelEvents, []);
  assert.ok(children.every(c => f.events.get(c.holdId)!.status === "cancelled"));
  assert.equal(f.read().status, "booked");
});

for (const failure of ["second child", "meeting"] as const) test(`failed ${failure} rolls back staged travel and leaves original booking intact`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", travel }, f.options);
  await calendarAction("r_one", { action: "book", start }, f.options);
  const before = f.read();
  let creates = 0;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "create" && ++creates === 2 && failure === "second child" || cmd.argv[2] === "update" && failure === "meeting") return { error: "write refused" };
    return f.command(cmd);
  };
  await assert.rejects(calendarAction("r_one", { action: "book", start: "2026-10-05T11:00:00Z" }, { ...f.options, command }), /previous offer retained/);
  assert.deepEqual(f.read().booked, before.booked);
  assert.deepEqual(f.read().travelEvents, before.travelEvents);
  assert.equal(f.events.get(before.eventId!)!.start.dateTime, start);
  assert.equal([...f.events.values()].filter(e => e.status !== "cancelled").length, 3);
  assert.deepEqual(f.read().holdCleanup, []);
});

test("lost travel create reconciles without duplication and cleanup failure remains owned until retry", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", travel }, f.options);
  const command = async (cmd: MacCommand) => {
    const result = await f.command(cmd);
    return cmd.argv[2] === "create" ? undefined : result;
  };
  await calendarAction("r_one", { action: "book", start }, { ...f.options, command });
  assert.equal(f.calls.filter(c => c[2] === "create").length, 2);
  const children = f.read().travelEvents!;
  await calendarAction("r_one", { action: "travel", travel: { beforeMin: 0, afterMin: 0, override: true } }, {
    ...f.options, command: async cmd => cmd.argv[2] === "delete" ? { error: "failed" } : f.command(cmd),
  });
  assert.deepEqual(f.read().travelEvents, []);
  assert.deepEqual(f.read().holdCleanup, children);
  await calendarAction("r_one", { action: "cleanup" }, f.options);
  assert.deepEqual(f.read().holdCleanup, []);
  assert.ok(children.every(c => f.events.get(c.holdId)!.status === "cancelled"));
});

test("travel bounds fail before any calendar operation and cannot bypass the seam", async t => {
  const f = fixture(t);
  for (const minutes of [-1, 121, 1.5, NaN]) {
    await assert.rejects(calendarAction("r_one", { action: "travel", travel: { beforeMin: minutes, afterMin: 0 } }, f.options), /whole minutes/);
  }
  assert.equal(f.calls.length, 0);
  const result = cli("ledger.ts", ["update", "--id", "r_one", "--json", JSON.stringify({ travel })], { MEETLY_HOME: f.home });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /managed by calendar.ts/);
});

test("travel commit failure resumes without recreating children; replacement expiry preserves booked travel", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format: "in_person", travel }, f.options);
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
  assert.equal(f.read().travelEvents, undefined);
  fail = false;
  await calendarAction("r_one", { action: "resume" }, f.options);
  assert.equal(f.calls.filter(c => c[2] === "create").length, 2);
  const children = f.read().travelEvents!;
  await calendarAction("r_one", { action: "offer", request: f.offer }, f.options);
  await calendarAction("r_one", { action: "expire" }, { ...f.options, now: () => now + 72 * 3600_000 });
  assert.deepEqual(f.read().travelEvents, children);
  assert.equal(f.read().status, "booked");
  assert.ok(children.every(c => f.events.get(c.holdId)!.status === "confirmed"));
});

test("resizing a booking records duration and a later move retains it", async t => {
  const f = fixture(t);
  await calendarAction("r_one", {action: "book", start}, f.options);
  await calendarAction("r_one", {action: "book", start, end: "2026-10-05T10:45:00Z"}, f.options);
  assert.equal(f.read().durationMin, 45);
  await calendarAction("r_one", {action: "book", start: "2026-10-07T10:00:00Z"}, f.options);
  assert.equal(Date.parse(f.read().booked!.end) - Date.parse(f.read().booked!.start), 45 * 60_000);
});


test("calendar CLI delivers travel privately and returns no travel data to its caller", async t => {
  const f = fixture(t, "group-with-guest");
  await calendarAction("r_one", { action: "book", start }, f.options);
  const sent: string[] = [];
  const result = await calendarCommand(["format", "--id", "r_one", "--json", JSON.stringify({
    format: "in_person", location: "Library", travel: { beforeMin: 10, afterMin: 10 },
  })], { ...f.options, sendOwner: async text => { sent.push(text); } });
  assert.doesNotMatch(JSON.stringify(result), /beforeMin|afterMin|ownerTravelNote|travelEvents|Held 10|say if/);
  assert.equal(result.ownerNotified, true);
  assert.equal(result.ownerReply, undefined, "format changes still need their meeting confirmation");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Held 10 min travel before and 10 min after/);
  assert.deepEqual(f.read().travel, { beforeMin: 10, afterMin: 10 });
  assert.equal(f.read().travelEvents!.length, 2);
  const resumed = await calendarCommand(["resume", "--id", "r_one"], { ...f.options, sendOwner: async text => { sent.push(text); } });
  assert.doesNotMatch(JSON.stringify(resumed), /beforeMin|afterMin|ownerTravelNote|travelEvents/);
  assert.equal(sent.length, 1, "resuming a completed write cannot duplicate the DM");
});


test("ledger CLI never returns private travel in booked or group lookups", async t => {
  const f = fixture(t, "group-with-guest");
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Library", travel: { beforeMin: 10, afterMin: 10 } }, f.options);
  await calendarAction("r_one", { action: "book", start }, f.options);
  for (const args of [["booked"], ["find", "--chat", "group-with-guest"]]) {
    const result = cli("ledger.ts", args, { MEETLY_HOME: f.home });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /beforeMin|afterMin|travelEvents/);
    assert.match(result.stdout, /Library/);
  }
  assert.equal(f.read().travel!.beforeMin, 10);
});

for (const delivered of [true, false]) test(`a travel-only correction suppresses a second owner reply only after delivery: ${delivered}`, async t => {
  const f = fixture(t, "group-with-guest");
  await calendarAction("r_one", { action: "format", format: "in_person", location: "Library", travel: { beforeMin: 10, afterMin: 10 } }, f.options);
  await calendarAction("r_one", { action: "book", start }, f.options);
  let sends = 0;
  const result = await calendarCommand(["travel", "--id", "r_one", "--json", JSON.stringify({
    travel: { beforeMin: 30, afterMin: 15, override: true },
  })], { ...f.options, sendOwner: async () => { sends++; if (!delivered) throw new Error("unknown delivery"); } });
  assert.equal(sends, 1);
  assert.equal(result.ownerNotified, delivered);
  assert.equal((result.ownerReply as { action?: string } | undefined)?.action, delivered ? "silent" : undefined);
  assert.equal(f.read().booked!.start, start);
  assert.equal(f.read().travel!.beforeMin, 30);
});

test("saved exact starts cannot be omitted on reoffer or bypassed at booking", async t => {
  const f = fixture(t);
  const request = { ...f.read(), constraints: { startTime: "11:30" } };
  writeJson(join(f.home, "ledger.json"), { requests: [request] });
  await assert.rejects(calendarAction("r_one", { action: "offer", request: f.offer }, f.options), /exact start/i);
  await assert.rejects(calendarAction("r_one", { action: "book", start }, f.options), /exact start/i);
  assert.deepEqual(f.calls, []);
  const offered = [{ start: "2026-10-05T11:30:00Z", end: "2026-10-05T12:00:00Z", account }];
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, offered } }, f.options);
  assert.equal(f.read().constraints?.startTime, "11:30");
});
for (const format of ["meet", "in_person"] as const) test(`attendee add preserves the ${format} booking`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "format", format, location: "Library",
    travel: { beforeMin: format === "meet" ? 0 : 15, afterMin: format === "meet" ? 0 : 15 } }, f.options);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com,second@example.com" }, f.options);
  await calendarAction("r_one", { action: "offer", request: { ...f.offer, offered: [f.offer.offered[1]!] } }, f.options);
  const before = f.read();
  const actual = f.events.get(before.eventId!)!;
  actual.start.dateTime = "2026-10-05T11:00:00Z";
  actual.end.dateTime = "2026-10-05T11:30:00Z";
  const event = structuredClone(actual);
  f.calls.length = 0;
  const email = "third@example.com";
  const result = await calendarAction("r_one", { action: "attendee", operation: "add", email }, f.options);
  assert.ok("invitationUpdated" in result && result.invitationUpdated);
  assert.equal("confirmationTime" in result && result.confirmationTime, "Mon, Oct 5, 11:00 AM UTC");
  assert.deepEqual(f.events.get(before.eventId!)!.attendees?.map(a => a.email), ["first@example.com", "second@example.com", email]);
  const { calendarRevision: _revision, ...after } = f.read();
  const { calendarRevision: _oldRevision, ...saved } = before;
  assert.deepEqual(after, saved);
  const changed = f.events.get(before.eventId!)!;
  assert.deepEqual(changed.start, event.start);
  assert.deepEqual(changed.end, event.end);
  assert.equal(changed.hangoutLink, event.hangoutLink);
  const writes = f.calls.filter(c => ["update", "create", "delete"].includes(c[2]!));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![2], "update");
  assert.equal(writes[0]![4], before.eventId);
  assert.equal(writes[0]![writes[0]!.indexOf("--send-updates") + 1], "all");
  for (const flag of ["--attendees", "--from", "--to", "--summary", "--with-meet", "--location"]) assert.ok(!writes[0]!.includes(flag), flag);
  f.calls.length = 0;
  const repeat = await calendarAction("r_one", { action: "attendee", operation: "add", email: email.toUpperCase() }, f.options);
  assert.ok("invitationUpdated" in repeat && !repeat.invitationUpdated);
  assert.equal("confirmationTime" in repeat && repeat.confirmationTime, "Mon, Oct 5, 11:00 AM UTC");
  assert.ok(f.calls.every(c => c[2] === "event"));
});

test("attendee edits reject an unbooked request before writes", async t => {
  const f = fixture(t);
  await assert.rejects(calendarAction("r_one", { action: "attendee", operation: "add", email: "new@example.com" }, f.options), /request is offered/);
  assert.deepEqual(f.calls, []);
});

test("uncertain attendee edits reconcile without sending the update twice", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com" }, f.options);
  const actual = f.events.get(f.read().eventId!)!;
  actual.start.dateTime = "2026-10-05T11:00:00Z";
  actual.end.dateTime = "2026-10-05T11:30:00Z";
  f.calls.length = 0;
  let hide = true;
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "event" && f.calls.some(c => c[2] === "update") && hide) return undefined;
    const result = await f.command(cmd);
    return cmd.argv[2] === "update" ? undefined : result;
  };
  await assert.rejects(calendarAction("r_one", { action: "attendee", operation: "add", email: "new@example.com" }, { ...f.options, command }), /unresolved/);
  hide = false;
  const resumed = await calendarAction("r_one", { action: "resume" }, { ...f.options, command });
  assert.ok("invitationUpdated" in resumed && resumed.invitationUpdated);
  assert.equal("confirmationTime" in resumed && resumed.confirmationTime, "Mon, Oct 5, 11:00 AM UTC");
  assert.equal(f.calls.filter(c => c[2] === "update").length, 1);
  assert.deepEqual(pendingCalendarWrites(), []);
});

test("concurrent attendee edits read the current guest list under the request lock", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com,second@example.com" }, f.options);
  f.calls.length = 0;
  await Promise.all([
    calendarAction("r_one", { action: "attendee", operation: "add", email: "third@example.com" }, f.options),
    calendarAction("r_one", { action: "attendee", operation: "add", email: "fourth@example.com" }, f.options),
  ]);
  assert.deepEqual(f.events.get(f.read().eventId!)!.attendees?.map(a => a.email), ["first@example.com", "second@example.com", "third@example.com", "fourth@example.com"]);
  assert.equal(f.calls.filter(c => c[2] === "update").length, 2);
});

for (const invalid of ["cancelled", "partial", "invalid-email"] as const) test(`attendee edit refuses ${invalid} before writing`, async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com,second@example.com" }, f.options);
  const event = f.events.get(f.read().eventId!)!;
  if (invalid === "cancelled") event.status = "cancelled";
  if (invalid === "partial") Object.assign(event, { attendeesOmitted: true });
  const before = f.read();
  f.calls.length = 0;
  await assert.rejects(calendarAction("r_one", { action: "attendee", operation: "add",
    email: invalid === "invalid-email" ? "first@example.com,second@example.com" : "new@example.com" }, f.options));
  assert.deepEqual(f.read(), before);
  assert.ok(f.calls.every(c => c[2] === "event"));
  assert.deepEqual(pendingCalendarWrites(), []);
});

test("attendee removal refuses without reading or rewriting the calendar", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com,second@example.com" }, f.options);
  const before = f.read(), event = structuredClone(f.events.get(before.eventId!)!);
  f.calls.length = 0;
  await assert.rejects(calendarAction("r_one", { action: "attendee", operation: "remove", email: "second@example.com" }, f.options),
    /Please remove the guest in your calendar app\./);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.events.get(before.eventId!), event);
  assert.deepEqual(pendingCalendarWrites(), []);
});

test("booking an existing hold adds invitees without replacing its attendee list", async t => {
  const f = fixture(t);
  const event = f.events.get("hold-one")!;
  const survivor = { email: "existing@example.com", responseStatus: "accepted", additionalGuests: 2, displayName: "Existing Guest" };
  event.attendees = [survivor];
  const command = async (cmd: MacCommand) => {
    if (cmd.argv[2] === "update") event.attendees!.push({ email: "external@example.com" });
    return f.command(cmd);
  };
  await calendarAction("r_one", { action: "book", start, attendees: "new@example.com" }, { ...f.options, command });
  assert.deepEqual(event.attendees, [survivor, { email: "external@example.com" }, { email: "new@example.com" }]);
  assert.ok(f.calls.filter(c => c[2] === "update").every(c => c.includes("--add-attendee") && !c.includes("--attendees")));
});


test("committed attendee recovery confirms the actual event time without another write", async t => {
  const f = fixture(t);
  await calendarAction("r_one", { action: "book", start, attendees: "first@example.com" }, f.options);
  const actual = f.events.get(f.read().eventId!)!;
  actual.start.dateTime = "2026-10-05T11:00:00Z";
  actual.end.dateTime = "2026-10-05T11:30:00Z";
  f.calls.length = 0;
  const rm = fs.rmSync;
  t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === join(f.home, "calendar", "r_one.json")) throw new Error("simulated journal cleanup failure");
    return rm(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(calendarAction("r_one", { action: "attendee", operation: "add", email: "new@example.com" }, f.options), /journal cleanup failure/);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const result = await calendarAction("r_one", { action: "resume" }, f.options);
  assert.ok("invitationUpdated" in result && result.invitationUpdated);
  assert.equal("confirmationTime" in result && result.confirmationTime, "Mon, Oct 5, 11:00 AM UTC");
  assert.equal(f.calls.filter(c => c[2] === "update").length, 1);
  assert.deepEqual(pendingCalendarWrites(), []);
});
