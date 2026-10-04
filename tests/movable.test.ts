import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerMovableTool } from "../plugin/owner-tools.js";
import { movableAction, type MovableArgs } from "../skills/meetly/scripts/movable.ts";
import { DEFAULTS, loadConfig, type Config } from "../skills/meetly/scripts/config.ts";
import { fetchBusy } from "../skills/meetly/scripts/busy.ts";
import { record, finish } from "../skills/meetly/scripts/record-setup.ts";
import { status } from "../skills/meetly/scripts/setup-status.ts";
import { view } from "../skills/meetly/scripts/request-view.ts";
import { addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, tmpHome } from "./helpers.ts";
import type { OwnerContext } from "../skills/meetly/scripts/owner-turn.ts";

const owner = { messageChannel: "plow", agentAccountId: "chat", sessionKey: "agent:main:main", senderIsOwner: true,
  requesterSenderId: "+15550001111", nativeChannelId: "owner-dm" };
const account = "owner@example.com";
const slot = { start: "2026-10-05T12:00:00Z", end: "2026-10-05T13:00:00Z" };
const inspect: MovableArgs = { action: "inspect", candidates: [slot], format: "in_person", travel: { beforeMin: 25, afterMin: 25 } };
const event = (id = "focus", start = "2026-10-05T11:40:00Z", end = "2026-10-05T11:55:00Z") => ({ ...calendarEvent(id, start, end), summary: "Focus block" });

function fixture(t: TestContext) {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; rmSync(home, { recursive: true, force: true }); });
  const config: Config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: account,
    calendars: [{ account, id: account }], setupDoneAt: "2026-10-01T00:00:00Z" };
  writeJson(join(home, "config.json"), config);
  let listing: any = { events: [event()] };
  const calls: string[][] = [];
  const options = { token: "fixture", fetch: async (_url: unknown, init?: RequestInit) => {
    const argv = JSON.parse(String(init?.body)).params.arguments.argv;
    assert.deepEqual(argv.slice(0, 3), ["plow-gog", "calendar", "events"], "inspection must never mutate a calendar");
    calls.push(argv);
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(listing) }) }] } });
  } };
  return { home, config, calls, options, set: (value: unknown) => { listing = value; } };
}

for (const ctx of [
  { ...owner, senderIsOwner: false }, { ...owner, requesterSenderId: undefined },
  { ...owner, sessionKey: "agent:main:plow:group:group-one" }, { ...owner, agentAccountId: "email" },
  { ...owner, messageChannel: "webchat" }, { ...owner, sessionKey: undefined },
]) test(`private inspection and memory reject ${JSON.stringify(ctx)}`, async t => {
  const f = fixture(t);
  const before = readFileSync(join(f.home, "config.json"), "utf8");
  for (const args of [inspect, { action: "remember", title: "Focus block", allowed: true } as const]) {
    const result = await movableAction(ctx, args, f.options);
    assert.ok("error" in result);
    assert.doesNotMatch(JSON.stringify(result), /Focus block/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), before);
});

test("private tool uses runtime identity, not caller-supplied identity", async t => {
  const f = fixture(t);
  let tool: any;
  registerMovableTool({ registerTool(factory: (ctx: OwnerContext) => unknown) { tool = factory({ ...owner, senderIsOwner: false }); } },
    (ctx, args) => movableAction(ctx, args, f.options));
  const result = await tool.execute("read", { ...inspect, senderIsOwner: true, sessionKey: owner.sessionKey });
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("one blocker across the full travel window returns only its title and previous answer", async t => {
  const f = fixture(t);
  const result = await movableAction(owner, inspect, f.options);
  assert.deepEqual(result, { candidates: [{ ...slot, title: "Focus block", previous: null }] });
  assert.doesNotMatch(JSON.stringify(result), /owner@example|focus"|PRIVATE|location|attendees/);
  assert.ok(f.calls[0]!.includes("2026-10-05T11:35:00.000Z"));
  assert.ok(f.calls[0]!.includes("2026-10-05T13:25:00.000Z"));
  assert.equal(existsSync(join(f.home, "tmp", "busy.json")), false);
  f.set({ events: [event(), event()] });
  assert.deepEqual(await movableAction(owner, inspect, f.options), result, "duplicate listings are one event");
  f.set({ events: [event(), { ...event("free"), transparency: "transparent" }, { ...event("cancelled"), status: "cancelled" }, { ...event("declined"), declined: true }] });
  assert.deepEqual(await movableAction(owner, inspect, f.options), result);
});

test("zero or two blockers do not become flexible candidates; the after-travel event counts too", async t => {
  const f = fixture(t);
  for (const events of [[], [event(), event("second", "2026-10-05T13:10:00Z", "2026-10-05T13:20:00Z")],
    [event(), { ...event("anonymous"), id: undefined }]]) {
    f.set({ events });
    assert.deepEqual(await movableAction(owner, inspect, f.options), { candidates: [] });
  }
  f.set({ events: [event("after", "2026-10-05T13:10:00Z", "2026-10-05T13:20:00Z")] });
  assert.equal((await movableAction(owner, inspect, f.options)).candidates!.length, 1);
  assert.deepEqual(await movableAction(owner, { ...inspect, format: "meet", travel: { beforeMin: 0, afterMin: 0 } }, f.options), { candidates: [] });
});

test("incomplete calendars fail closed rather than suggesting a sole blocker", async t => {
  const f = fixture(t);
  for (const listing of [
    { events: [event()], degraded: [account] }, { events: [event()], truncated: { after: slot.start } },
    { events: [event()], nextPageToken: "next" }, { events: [event()], errors: ["unavailable"] },
    { events: Array.from({ length: 100 }, (_, i) => event(String(i))) }, { events: [{ id: "bad" }] },
  ]) {
    f.set(listing);
    assert.ok("error" in await movableAction(owner, inspect, f.options));
  }
  assert.ok("error" in await movableAction(owner, inspect, { token: "fixture", fetch: async () => new Response("", { status: 503 }) }));
});

test("request travel is excluded by account and id, and saved overrides determine the inspected window", async t => {
  const f = fixture(t);
  const ledger = addRequest({ requests: [] }, { origin: "owner", handle: "+15550002222", topic: "Lunch", durationMin: 60,
    format: "in_person", travel: { beforeMin: 45, afterMin: 45, override: true }, offered: [{ ...slot, account, holdId: "own-hold" }] }, Date.now(), "r");
  const request = { ...ledger.requests[0]!, status: "booked" as const, eventId: "own-meeting", booked: { ...slot, account },
    travelEvents: [{ holdId: "own-travel", account }], reoffer: { offered: [{ ...slot, account, holdId: "own-hold" }], offeredAt: new Date().toISOString() } };
  writeJson(join(f.home, "ledger.json"), { requests: [request] });
  f.set({ events: [event(), event("own-travel"), event("own-hold"), event("own-meeting")] });
  const result = await movableAction(owner, { ...inspect, requestId: "r" }, f.options);
  assert.equal(result.candidates!.length, 1);
  assert.ok(f.calls[0]!.includes("2026-10-05T11:15:00.000Z"));
  assert.ok(f.calls[0]!.includes("2026-10-05T13:45:00.000Z"));
  assert.deepEqual(view(request, f.config).booked?.start, slot.start);
  assert.doesNotMatch(JSON.stringify(view(request, f.config)), /Focus block|overlapDecisions/);
  const before = readFileSync(join(f.home, "ledger.json"), "utf8");
  await movableAction(owner, { action: "remember", title: "Focus block", allowed: true }, f.options);
  assert.equal(readFileSync(join(f.home, "ledger.json"), "utf8"), before, "remembering cannot grant an overlap");
  assert.equal(readJson<Ledger>(join(f.home, "ledger.json"), { requests: [] }).requests[0]!.allowOverlap, undefined);
});

test("normalized allowed/refused memory only phrases the next private ask and survives settings edits", async t => {
  const f = fixture(t);
  for (const allowed of [true, false]) {
    const result = await movableAction(owner, { action: "remember", title: "  FOCUS BLOCK  ", allowed }, f.options);
    assert.equal(result.grantsOverlap, false);
    const read = await movableAction(owner, inspect, f.options);
    assert.equal(read.candidates![0]!.previous!.allowed, allowed);
    assert.ok(Number.isFinite(Date.parse(read.candidates![0]!.previous!.at)));
    const busy = await fetchBusy(f.config, { from: "2026-10-05T11:00:00Z", to: "2026-10-05T14:00:00Z" }, f.options);
    assert.equal(busy.allowOverlap, undefined, "memory is never calendar permission");
    assert.equal(busy.busy.length, 1);
    assert.doesNotMatch(JSON.stringify(busy), /Focus block/);
  }
  assert.doesNotMatch(JSON.stringify(loadConfig()), /overlapDecisions|focus block/);
  assert.doesNotMatch(JSON.stringify(status()), /overlapDecisions|focus block/);
  assert.doesNotMatch(JSON.stringify(record("ownerName", "Jean")), /overlapDecisions|focus block/);
  assert.doesNotMatch(JSON.stringify(finish(() => ({}))), /overlapDecisions|focus block/);
  const saved = readJson<Config>(join(f.home, "config.json"), f.config);
  assert.equal(saved.ownerName, "Jean");
  assert.equal(saved.overlapDecisions!["focus block"]!.allowed, false);
  assert.deepEqual(Object.keys(saved.overlapDecisions!), ["focus block"]);
});

test("inspection is capped at two candidates and rejects invalid times or minutes before reads", async t => {
  const f = fixture(t);
  for (const args of [{ ...inspect, candidates: [slot, slot, slot] }, { ...inspect, candidates: [{ start: "bad", end: slot.end }] },
    { ...inspect, travel: { beforeMin: 121, afterMin: 0 } }]) assert.ok("error" in await movableAction(owner, args, f.options));
  assert.equal(f.calls.length, 0);
});

test("identical event ids in different calendar accounts are two blockers", async t => {
  const f = fixture(t);
  writeJson(join(f.home, "config.json"), { ...f.config, calendars: [...f.config.calendars, { account: "work@example.com", id: "work@example.com" }] });
  assert.deepEqual(await movableAction(owner, inspect, f.options), { candidates: [] });
  assert.equal(f.calls.length, 2);
});
