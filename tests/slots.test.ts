import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Config } from "../skills/meetly/scripts/config.ts";
import { checkTime, findSlots, resolveSearchConstraints, type SlotQuery } from "../skills/meetly/scripts/slots.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { addRequest } from "../skills/meetly/scripts/ledger.ts";
import { cli, tmpHome } from "./helpers.ts";

const CONFIG: Config = {
  ownerName: "Jean",
  timezone: "America/Sao_Paulo",
  days: ["mon", "tue", "wed", "thu", "fri"],
  windowStart: "09:00",
  windowEnd: "18:00",
  durationMin: 30,
  horizonDays: 7,
  calendars: [{ account: "jean@example.com", id: "primary" }],
  defaultAccount: "jean@example.com",
  setupDoneAt: "2026-09-26T12:00:00.000Z",
};
const NOW = Date.parse("2026-09-28T08:00:00-03:00");
const coverage = { from: "2026-09-28T00:00:00Z", to: "2026-11-10T00:00:00Z" };
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ travel: { beforeMin: 0, afterMin: 0 }, now: NOW, config: CONFIG, durationMin: 30, busy: [], coverage, ...over });
const starts = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.start);
const labels = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.label);

test("Kelp busy exact time returns covered nearby alternatives without its saved start pin", async (t) => {
  const home = tmpHome(), busyFile = join(home, "busy.json"), callsFile = join(home, "reads.json"), hook = join(home, "bridge.mjs");
  const now = Date.parse("2026-10-05T04:00:00-07:00"), start = "2026-10-29T14:00:00-07:00";
  const config = { ...CONFIG, timezone: "America/Los_Angeles", horizonDays: 14 };
  const busy = { start: "2026-10-29T19:45:00.000Z", end: "2026-10-29T21:30:00.000Z", id: "private-permits", account: "jean@example.com" };
  writeJson(join(home, "config.json"), config);
  writeJson(busyFile, { busy: [busy], coverage: { from: "2026-10-29T20:00:00Z", to: "2026-10-29T23:00:00Z" }, degraded: [] });
  writeFileSync(hook, `
    import { writeFileSync } from "node:fs";
    Date.now = () => ${now};
    globalThis.fetch = async (_url, init) => {
      if (process.env.CALENDAR_FIXTURE_ERROR) return new Response("{}", { status: 503 });
      const { argv } = JSON.parse(init.body).params.arguments;
      writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(argv));
      const listing = { events: [{ id: "private-permits", summary: "PRIVATE TITLE", start: { dateTime: ${JSON.stringify(busy.start)} }, end: { dateTime: ${JSON.stringify(busy.end)} } }] };
      if (process.env.CALENDAR_FIXTURE_TRUNCATED) listing.truncated = { after: "2026-10-29T21:40:00Z" };
      return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(listing) }) }] } });
    };
  `);
  const env = { MEETLY_HOME: home, PLOW_MCP_BRIDGE_TOKEN: "fixture", NODE_OPTIONS: `--import=${hook}` };
  const args = ["--in", busyFile, "--at", start, "--now", new Date(now).toISOString(), "--duration", "45", "--format", "meet", "--travel", '{"beforeMin":0,"afterMin":0}'];
  const check = cli("slots.ts", args, env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.reason, "busy");
  assert.deepEqual(check.json.alternatives?.map((s: { start: string }) => s.start), ["2026-10-29T14:30:00-07:00", "2026-10-29T15:00:00-07:00", "2026-10-29T15:30:00-07:00"]);
  const reads = readJson<string[]>(callsFile, []), flag = (name: string) => reads[reads.indexOf(name) + 1]!;
  assert.equal(reads[2], "events");
  assert.equal(Date.parse(flag("--from")), Date.parse("2026-10-27T00:00:00-07:00"));
  assert.equal(Date.parse(flag("--to")), Date.parse("2026-11-01T00:00:00-07:00"));
  assert.doesNotMatch(check.stdout, /private-permits|PRIVATE TITLE|jean@example/);
  assert.match(check.json.next.reply, /same reply/);

  const input = { origin: "owner" as const, status: "asked" as const, offered: [], handle: "+15550116003", topic: "Kelp-farm permitting review", durationMin: 45,
    format: "meet" as const, travel: { beforeMin: 0, afterMin: 0 }, constraints: { startTime: "14:00", before: "16:00" } };
  const ledger = addRequest(addRequest({ requests: [] }, input, now, "kelp"), { ...input, handle: "+15550116004" }, now, "other");
  writeJson(join(home, "ledger.json"), ledger);
  const pinned = cli("slots.ts", [...args, "--request", "kelp"], env);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.json.alternatives[0].start, "2026-10-29T14:30:00-07:00");
  assert.ok(pinned.json.alternatives.every((s: { end: string }) => s.end.slice(11, 16) <= "16:00"));
  assert.equal(pinned.json.resolvedConstraints.startTime, undefined);
  assert.equal(pinned.json.resolvedConstraints.before, "16:00");
  const saved = readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] });
  assert.deepEqual(saved.requests.find(r => r.id === "kelp")!.constraints, { before: "16:00" });
  assert.equal(saved.requests.find(r => r.id === "other")!.constraints?.startTime, "14:00");
  const free = cli("slots.ts", [...args.slice(0, 2), "--at", "2026-10-29T15:00:00-07:00", ...args.slice(4), "--request", "other"], env);
  assert.equal(free.json.free, true, free.stderr);
  assert.equal(readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] }).requests.find(r => r.id === "other")!.constraints?.startTime, "14:00");
  writeJson(join(home, "ledger.json"), { ...ledger, requests: ledger.requests.map(r => r.id === "other" ? { ...r, constraints: { startTime: "11:30" } } : r) });
  const independent = cli("slots.ts", [...args, "--request", "other"], env);
  assert.ok(independent.json.alternatives.length);
  assert.ok(independent.json.alternatives.every((s: { start: string }) => s.start.slice(11, 16) === "11:30"));
  assert.equal(independent.json.resolvedConstraints.startTime, "11:30");
  await t.test("one exact-time call applies and saves hard conditions without pinning the busy start", () => {
    writeJson(join(home, "ledger.json"), { ...ledger, requests: ledger.requests.map(r => r.id === "kelp" ? { ...r, constraints: { startTime: "14:00" } } : r) });
    const constrained = cli("slots.ts", [...args, "--request", "kelp", "--before", "16:00", "--after", "13:00", "--days", "thu", "--from", "2026-10-29", "--to", "2026-10-29"], env);
    assert.equal(constrained.status, 0, constrained.stderr);
    assert.equal(constrained.json.reason, "busy");
    assert.equal(constrained.json.outsideHours, false);
    assert.deepEqual(constrained.json.alternatives.map((s: { start: string }) => s.start), ["2026-10-29T14:30:00-07:00", "2026-10-29T15:00:00-07:00"]);
    const saved = readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] });
    assert.deepEqual(saved.requests.find(r => r.id === "kelp")!.constraints, { days: ["thu"], after: "13:00", before: "16:00", from: "2026-10-29", to: "2026-10-29" });
    assert.deepEqual(saved.requests.find(r => r.id === "other"), ledger.requests.find(r => r.id === "other"));
    const again = cli("slots.ts", [...args, "--request", "kelp"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.json.alternatives, constrained.json.alternatives);
    const rejected = cli("slots.ts", [...args, "--request", "kelp", "--start-time", "14:00"], env);
    assert.equal(rejected.status, 1);
    assert.equal(readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] }).requests.find(r => r.id === "kelp")!.constraints?.startTime, undefined);
  });
  const replacementPolicy = { days: ["thu"], after: "13:00", before: "16:00", from: "2026-10-29", to: "2026-10-29" };
  const replacementCases = [
    { name: "an exact-time owner day replaces saved days and preserves omitted conditions",
      conditions: { ...replacementPolicy, startTime: "14:00", days: ["mon"] }, flags: ["--days", "thu"], expected: replacementPolicy, alternatives: check.json.alternatives.slice(0, 2) },
    { name: "an exact-time owner deadline replaces the saved deadline for checking, alternatives and persistence",
      conditions: replacementPolicy, flags: ["--before", "17:00"], expected: { ...replacementPolicy, before: "17:00" }, alternatives: check.json.alternatives, freeStart: "2026-10-29T15:30:00-07:00" },
  ];
  for (const { name, conditions, flags, expected, alternatives, freeStart } of replacementCases) await t.test(name, () => {
    const seeded = { ...ledger, requests: ledger.requests.map(r => r.id === "kelp" ? { ...r, constraints: conditions } : r) };
    writeJson(join(home, "ledger.json"), seeded);
    if (freeStart) {
      writeJson(busyFile, { busy: [busy], coverage, degraded: [] });
      const free = cli("slots.ts", [...args.slice(0, 2), "--at", freeStart, ...args.slice(4), "--request", "kelp", ...flags], env);
      assert.equal(free.status, 0, free.stderr);
      assert.equal(free.json.free, true);
      assert.equal(free.json.outsideHours, false);
      assert.deepEqual(readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] }).requests.find(r => r.id === "kelp")!.constraints, expected);
      writeJson(join(home, "ledger.json"), seeded);
    }
    const result = cli("slots.ts", [...args, "--request", "kelp", ...flags], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.reason, "busy");
    assert.equal(result.json.outsideHours, false);
    assert.deepEqual(result.json.alternatives, alternatives);
    assert.deepEqual(result.json.resolvedConstraints, expected);
    const saved = readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] });
    assert.deepEqual(saved.requests.find(r => r.id === "kelp")!.constraints, expected);
    assert.deepEqual(saved.requests.find(r => r.id === "other"), ledger.requests.find(r => r.id === "other"));
  });
  await t.test("a busy check never saves its matching start pin outside the passed date range", () => {
    writeJson(join(home, "ledger.json"), ledger);
    const outside = cli("slots.ts", [...args, "--request", "kelp", "--from", "2026-10-06", "--to", "2026-10-21"], env);
    assert.equal(outside.status, 0, outside.stderr);
    assert.equal(outside.json.reason, "busy");
    assert.equal(outside.json.outsideHours, true);
    assert.deepEqual(outside.json.alternatives, []);
    assert.equal(outside.json.resolvedConstraints.startTime, undefined);
    assert.deepEqual(readJson<typeof ledger>(join(home, "ledger.json"), { requests: [] }).requests.find(r => r.id === "kelp")!.constraints,
      { before: "16:00", from: "2026-10-06", to: "2026-10-21" });
  });
  await t.test("a complete refetch clears the earlier truncation cutoff", () => {
    writeJson(busyFile, { busy: [busy], coverage, unknownAfter: "2026-10-29T22:00:00Z", degraded: [] });
    const refreshed = cli("slots.ts", args, env);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.json.alternativesIncomplete, undefined);
    assert.deepEqual(refreshed.json.alternatives, check.json.alternatives);
  });
  await t.test("alternatives retain input and saved overlap permission, unless revoked", () => {
    const allowed = { ...busy, id: "authorized", start: "2026-10-29T21:30:00.000Z", end: "2026-10-29T23:15:00.000Z" };
    const allowOverlap = [{ account: allowed.account, id: allowed.id }];
    writeJson(busyFile, { busy: [busy, allowed], coverage, allowOverlap, degraded: [] });
    const fromInput = cli("slots.ts", args, env);
    assert.equal(fromInput.status, 0, fromInput.stderr);
    assert.deepEqual(fromInput.json.alternatives, check.json.alternatives);
    writeJson(busyFile, { busy: [busy, allowed], coverage, degraded: [] });
    writeJson(join(home, "ledger.json"), { ...ledger, requests: ledger.requests.map(r => r.id === "kelp" ? { ...r, allowOverlap } : r) });
    const fromRequest = cli("slots.ts", [...args, "--request", "kelp"], env);
    assert.equal(fromRequest.status, 0, fromRequest.stderr);
    assert.equal(fromRequest.json.alternatives[0].start, "2026-10-29T14:30:00-07:00");
    const revoked = cli("slots.ts", [...args, "--request", "kelp", "--no-overlap"], env);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.ok(revoked.json.alternatives.length);
    assert.ok(revoked.json.alternatives.every((s: { start: string; end: string }) => Date.parse(s.end) <= Date.parse(allowed.start) || Date.parse(s.start) >= Date.parse(allowed.end)));
  });
  writeJson(busyFile, { busy: [busy], coverage: { from: "2026-10-29T20:00:00Z", to: "2026-10-29T23:00:00Z" }, degraded: [] });
  const unavailable = cli("slots.ts", args, { ...env, CALENDAR_FIXTURE_ERROR: "1" });
  assert.deepEqual(unavailable.json.alternatives, []);
  assert.deepEqual(unavailable.json.degraded, ["jean@example.com"]);
  const truncated = cli("slots.ts", args, { ...env, CALENDAR_FIXTURE_TRUNCATED: "1" });
  assert.deepEqual(truncated.json.alternatives, []);
  assert.equal(truncated.json.alternativesIncomplete.reason, "truncated-calendar");
});

test("exact-time checks report every hard-condition boundary", () => {
  const start = "2026-09-28T10:00:00-03:00";
  for (const conditions of [{ before: "10:29" }, { after: "10:01" }, { days: ["tue"] }, { from: "2026-09-29" }, { to: "2026-09-27" }]) {
    assert.equal(checkTime({ ...q(conditions), start }).outsideHours, true, JSON.stringify(conditions));
  }
  assert.equal(checkTime({ ...q({ days: ["mon"], after: "10:00", before: "10:30", from: "2026-09-28", to: "2026-09-28" }), start }).outsideHours, false);
});

test("no busy: spread over the first days, after the minimum notice", () => {
  const { slots, unknownAfter } = findSlots(q());
  assert.deepEqual(slots, [
    { start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00", dayOfWeek: "mon", label: "mon 28/9 10:00 America/Sao_Paulo" },
    { start: "2026-09-29T09:00:00-03:00", end: "2026-09-29T09:30:00-03:00", dayOfWeek: "tue", label: "tue 29/9 09:00 America/Sao_Paulo" },
    { start: "2026-09-30T09:00:00-03:00", end: "2026-09-30T09:30:00-03:00", dayOfWeek: "wed", label: "wed 30/9 09:00 America/Sao_Paulo" },
  ]);
  assert.equal(unknownAfter, undefined);
});

test("an oversized count still offers only three times, while smaller counts are honored", () => {
  assert.deepEqual(starts({ count: 6 }), starts());
  for (const count of [1, 2]) assert.deepEqual(starts({ count }), starts().slice(0, count));
});

test("busy time is skipped unless its event may be overlapped", () => {
  const busy = [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }];
  assert.equal(starts({ busy })[0], "2026-09-28T11:00:00-03:00");
  assert.equal(starts({ busy, allowOverlap: ["weekly"] as any })[0], "2026-09-28T11:00:00-03:00");
  assert.equal(starts({ busy, allowOverlap: [{ account: "jean@example.com", id: "weekly" }] })[0], "2026-09-28T10:00:00-03:00");
  busy.push({ ...busy[0]!, account: "other@example.com" });
  const allowOverlap = [{ account: "jean@example.com", id: "weekly" }];
  assert.equal(starts({ busy, allowOverlap })[0], "2026-09-28T11:00:00-03:00");
  assert.equal(checkTime({ ...q({ busy, allowOverlap }), start: "2026-09-28T10:00:00-03:00" }).free, false);
  assert.equal(checkTime({ ...q({ busy: busy.slice(0, 1), allowOverlap }), start: "2026-09-28T10:00:00-03:00" }).free, true);
});

test("weekends and after-hours are skipped", () => {
  assert.deepEqual(labels({ now: Date.parse("2026-10-02T17:00:00-03:00") }), ["mon 5/10 09:00 America/Sao_Paulo", "tue 6/10 09:00 America/Sao_Paulo", "wed 7/10 09:00 America/Sao_Paulo"]);
});

test("request days intersect the config days and after narrows the window", () => {
  assert.deepEqual(labels({ days: ["thu"], after: "13:00" }), ["thu 1/10 13:00 America/Sao_Paulo", "thu 1/10 13:30 America/Sao_Paulo", "thu 1/10 14:00 America/Sao_Paulo"]);
  assert.deepEqual(labels({ days: ["thu"], after: "13:10", before: "14:00" }), ["thu 1/10 13:30 America/Sao_Paulo"]);
});

test("requests only narrow the configured days and window", () => {
  assert.deepEqual(starts({ days: ["sat"] }), []);
  assert.deepEqual(starts({ days: ["mon"], after: "19:00", before: "21:00" }), []);
  assert.deepEqual(labels({ after: "07:00", before: "09:30", count: 2 }), ["tue 29/9 09:00 America/Sao_Paulo", "wed 30/9 09:00 America/Sao_Paulo"]);
});

test("excluded starts are not offered", () => {
  assert.equal(starts({ exclude: ["2026-09-28T13:00:00.000Z"] })[0], "2026-09-28T10:30:00-03:00");
});

test("nothing is offered past the end of what was read", () => {
  const r = findSlots(q({ unknownAfter: "2026-09-29T09:15:00-03:00" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 28/9 10:00 America/Sao_Paulo", "mon 28/9 10:30 America/Sao_Paulo", "mon 28/9 11:00 America/Sao_Paulo"]);
  assert.equal(r.unknownAfter, "2026-09-29T09:15:00-03:00");
});

test("a date range narrows a longer horizon", () => {
  const config = { ...CONFIG, horizonDays: 14 };
  const r = findSlots(q({ config, from: "2026-10-05", to: "2026-10-06" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 5/10 09:00 America/Sao_Paulo", "mon 5/10 09:30 America/Sao_Paulo", "tue 6/10 09:00 America/Sao_Paulo"]);
});

test("a long meeting must end inside the window", () => {
  const busy = [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T20:00:00.000Z" }];
  assert.deepEqual(starts({ busy, durationMin: 60, days: ["mon"], count: 1 }), ["2026-09-28T17:00:00-03:00"]);
});

test("daylight saving ends: 09:00 stays 09:00 local", () => {
  const config: Config = {
    ...CONFIG,
    timezone: "America/Los_Angeles",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    windowStart: "09:00",
    windowEnd: "10:00",
    horizonDays: 5,
  };
  const r = findSlots(q({ now: Date.parse("2026-10-30T12:00:00-07:00"), config, durationMin: 60 }));
  assert.deepEqual(r.slots.map((s) => s.start), [
    "2026-10-31T09:00:00-07:00",
    "2026-11-01T09:00:00-08:00",
    "2026-11-02T09:00:00-08:00",
  ]);
});

test("labels follow the other person's locale", () => {
  assert.deepEqual(labels({ locale: "pt-BR" }), ["seg., 28/09, 10:00 BRT", "ter., 29/09, 09:00 BRT", "qua., 30/09, 09:00 BRT"]);
  assert.deepEqual(labels({ locale: "en-US", count: 1 }), ["Mon, 9/28, 10:00 AM GMT-3"]);
  assert.deepEqual(labels({ locale: "de-DE", count: 1 }), ["Mo., 28.9., 10:00 GMT-3"]);
  assert.equal(findSlots(q({ locale: "en-US" })).slots[0]!.dayOfWeek, "mon");
  assert.throws(() => findSlots(q({ locale: "not a locale!" })), /unknown locale/);
});

test("the CLI reads busy.ts output and the stored config", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeFileSync(busyFile, JSON.stringify({
    busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }],
    degraded: [], coverage,
  }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00", "--duration", "30"];
  const r = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slots[0].start, "2026-09-28T11:00:00-03:00");
  assert.deepEqual(r.json.degraded, []);
  const oversized = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--count", "6"], env);
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.deepEqual(oversized.json, r.json);
  const allowed = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--allow-overlap", '{"account":"jean@example.com","id":"weekly"}', "--count", "1"], env);
  assert.deepEqual(allowed.json.slots.map((s: { label: string }) => s.label), ["mon 28/9 10:00 America/Sao_Paulo"]);
  const at = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now.slice(0, 2), "--at", "2026-10-03T10:00:00-03:00", "--duration", "60", "--locale", "pt-BR"], env);
  assert.equal(at.status, 0, at.stderr);
  assert.deepEqual(at.json, {
    slot: { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T11:00:00-03:00", dayOfWeek: "sat", label: "sáb., 03/10, 10:00 BRT" },
    free: true,
    outsideHours: true,
    degraded: [],
  });
  const saturday = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--at", "2026-10-03T10:00:00-03:00", "--days", "sat"], env);
  assert.equal(saturday.status, 0, saturday.stderr);
  assert.equal(saturday.json.outsideHours, true);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--owner"], env).status, 1);
  const authorizedFile = join(home, "authorized-busy.json");
  writeJson(authorizedFile, { coverage, busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }], allowOverlap: [{ account: "jean@example.com", id: "weekly" }] });
  const authorized = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", authorizedFile, ...now, "--count", "1"], env);
  assert.deepEqual(authorized.json.slots, allowed.json.slots);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", authorizedFile, ...now, "--at", "2026-09-28T10:00:00-03:00"], env).json.free, true);
  assert.doesNotMatch(authorized.stdout, /weekly|allowOverlap/);
  const us = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--locale", "en-US", "--count", "1"], env);
  assert.deepEqual(us.json.slots.map((s: { label: string }) => s.label), ["Mon, 9/28, 11:00 AM GMT-3"]);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--locale", "??"], env).status, 1);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--days", "someday"], env).status, 1);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--from", "5/10"], env).status, 1);
  const boundedArgs = ["--in", busyFile, ...now, "--duration", "30", "--days", "mon",
    "--from", "2026-09-28", "--to", "2026-09-28", "--after", "10:00", "--before", "14:00"];
  const nearCases: [string, string[] | null][] = [
    ["2026-09-28T10:30:00-03:00", ["11:00", "11:30", "12:00"]],
    ["2026-09-28T13:30:00-03:00", ["13:30", "13:00", "12:30"]],
    ["tomorrow", null],
  ];
  for (const [near, expected] of nearCases) {
    const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', ...boundedArgs, "--near", near], env);
    assert.equal(result.status, expected ? 0 : 1, result.stderr);
    if (expected) assert.deepEqual(result.json.slots.map((s: { start: string }) => s.start),
      expected.map(time => `2026-09-28T${time}:00-03:00`));
  }
});

test("an unreadable calendar stops owner searches and time checks", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { busy: [], degraded: ["other@example.com"], coverage });
  const args = ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--duration", "30"];
  const search = cli("slots.ts", args, { MEETLY_HOME: home });
  assert.equal(search.status, 0, search.stderr);
  assert.deepEqual(search.json.slots, []);
  assert.match(search.json.next.reply, /other@example\.com/);
  const exact = cli("slots.ts", [...args, "--at", "2026-09-28T10:00:00-03:00"], { MEETLY_HOME: home });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.json.free, false);
  assert.equal(exact.json.reason, "unknown");
  assert.deepEqual(exact.json.degraded, ["other@example.com"]);
  assert.match(exact.json.next.reply, /other@example\.com/);
});

test("owner re-offer uses saved week bounds and ignores only its own holds", () => {
  const home = tmpHome();
  const account = CONFIG.defaultAccount;
  writeJson(join(home, "config.json"), { ...CONFIG, horizonDays: 21 });
  const offered = [
    { start: "2026-10-06T11:30:00-03:00", end: "2026-10-06T12:00:00-03:00", holdId: "hold-1", account },
    { start: "2026-10-06T12:00:00-03:00", end: "2026-10-06T12:30:00-03:00", holdId: "hold-2", account },
  ];
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    travel: { beforeMin: 0, afterMin: 0 }, origin: "owner", handle: "+15550107812", topic: "lunch", durationMin: 30, offered,
    constraints: { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-11", after: "11:30", before: "14:00" },
  }, NOW, "lunch"));
  const busyFile = join(home, "busy.json");
  const busy = offered.map(o => ({ start: o.start, end: o.end, id: o.holdId, account }));
  const args = ["--in", busyFile, "--request", "lunch", "--now", "2026-10-02T20:00:00-03:00", "--duration", "60", "--days", "tue", "--from", "2026-10-01", "--to", "2026-10-20"];
  const run = (extra: object[] = []) => {
    writeJson(busyFile, { coverage, busy: [...busy, ...extra], degraded: [] });
    return cli("slots.ts", args, { MEETLY_HOME: home });
  };
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, offered[0]!.start);
  assert.equal(result.json.slots[0].end, offered[1]!.end);
  assert.ok(result.json.slots.every((s: { start: string; end: string }) => s.start.startsWith("2026-10-06") && s.end.slice(11, 16) <= "14:00"));
  const blocked = run([{ id: "hold-1", account: "another@example.com", start: "2026-10-06T11:30:00-03:00", end: "2026-10-06T14:00:00-03:00" }]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(blocked.json.slots, []);
  const unknown = cli("slots.ts", args.map(a => a === "lunch" ? "missing" : a), { MEETLY_HOME: home });
  assert.notEqual(unknown.status, 0);
});

test("checkTime: a time the person insists on", () => {
  const check = (start: string, over: Partial<Parameters<typeof checkTime>[0]> = {}) =>
    checkTime({ ...q(), start, ...over });
  assert.deepEqual(check("2026-09-28T10:00:00-03:00"), {
    slot: { start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00", dayOfWeek: "mon", label: "mon 28/9 10:00 America/Sao_Paulo" },
    free: true,
    outsideHours: false,
  });
  const sat = check("2026-10-03T10:00:00-03:00");
  assert.equal(sat.free, true);
  assert.equal(sat.outsideHours, true);
  assert.equal(check("2026-09-29T19:00:00-03:00").outsideHours, true);
  assert.equal(check("2026-09-29T17:45:00-03:00").outsideHours, true);
  assert.equal(check("2026-09-29T08:30:00-03:00").outsideHours, true);
  assert.equal(check("2026-09-29T17:30:00-03:00").outsideHours, false);
  const busy = [{ start: "2026-10-03T12:30:00.000Z", end: "2026-10-03T13:30:00.000Z", id: "gym", account: "jean@example.com" }];
  assert.deepEqual(
    [check("2026-10-03T10:00:00-03:00", { busy }).free, check("2026-10-03T10:00:00-03:00", { busy }).reason],
    [false, "busy"],
  );
  assert.equal(check("2026-10-03T10:00:00-03:00", { busy, allowOverlap: [{ account: "jean@example.com", id: "gym" }] }).free, true);
  assert.equal(check("2026-09-28T09:00:00-03:00").reason, "too-soon");
  assert.equal(check("2026-10-03T10:00:00-03:00", { unknownAfter: "2026-10-02T00:00:00-03:00" }).reason, "unknown");
  assert.equal(check("2026-10-03T10:00:00-03:00", { locale: "en-US" }).slot.label, "Sat, 10/3, 10:00 AM GMT-3");
  assert.equal(check("2026-10-03T10:00").slot.start, "2026-10-03T10:00:00-03:00");
  assert.throws(() => check("someday"), /not a time/);
});

test("replacement slot search keeps saved and newly resolved overlap authorizations private", () => {
  const home = tmpHome(), env = { MEETLY_HOME: home };
  writeJson(join(home, "config.json"), CONFIG);
  const start = "2026-09-28T10:00:00-03:00", end = "2026-09-28T11:00:00-03:00";
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, { travel: { beforeMin: 0, afterMin: 0 },
    origin: "owner", chatUid: "group", handle: "+15551234567", topic: "Lunch", durationMin: 60,
    allowOverlap: [{ account: "jean@example.com", id: "saved" }], offered: [{ start, end, holdId: "own-hold", account: "jean@example.com" }],
  }, Date.parse(start), "r_one"));
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { coverage, busy: ["saved", "new", "own-hold"].map(id => ({ id, start, end, account: "jean@example.com" })), allowOverlap: [{ account: "jean@example.com", id: "new" }] });
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--after", "10:00", "--count", "1"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, start);
  assert.doesNotMatch(result.stdout, /saved|new|own-hold|allowOverlap/);
  const args = ["--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--at", start];
  const checked = cli("slots.ts", args, env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.free, true);
  assert.equal(checked.json.slot.end, end);
  const approval = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', ...args, "--no-overlap"], env);
  assert.equal(approval.status, 0, approval.stderr);
  assert.equal(approval.json.free, false);
  assert.equal(approval.json.reason, "busy");
  const alternatives = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--near", start, "--no-overlap"], env);
  assert.equal(alternatives.status, 0, alternatives.stderr);
  assert.equal(alternatives.json.slots[0].start, end);

  assert.doesNotMatch(checked.stdout, /saved|new|own-hold|allowOverlap/);
  writeJson(busyFile, { coverage, busy: [{ id: "saved", start, end, account: "other@example.com" }] });
  const blocked = cli("slots.ts", args, env);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.reason, "busy");
  assert.notEqual(cli("slots.ts", args.map(a => a === "r_one" ? "missing" : a), env).status, 0);
});

test("slot planning uses the owner's configured duration when omitted", () => {
  const query = q({ durationMin: undefined, config: { ...CONFIG, durationMin: 45 } });
  const slot = findSlots(query).slots[0]!;
  assert.equal(Date.parse(slot.end) - Date.parse(slot.start), 45 * 60_000);
  const checked = checkTime({ travel: { beforeMin: 0, afterMin: 0 }, ...query, start: slot.start });
  assert.equal(Date.parse(checked.slot.end) - Date.parse(checked.slot.start), 45 * 60_000);
});

test("explicit dates beyond the default horizon are searched", () => {
  assert.deepEqual(starts({ from: "2026-10-29", to: "2026-10-29" }), [
    "2026-10-29T09:00:00-03:00", "2026-10-29T09:30:00-03:00", "2026-10-29T10:00:00-03:00",
  ]);
  assert.equal(starts({ from: "2026-10-29" })[0], "2026-10-29T09:00:00-03:00");
});

test("raw busy CLI output without coverage cannot make unread dates available", () => {
  const home = tmpHome(), env = { MEETLY_HOME: home };
  writeJson(join(home, "config.json"), CONFIG);
  const raw = join(home, "raw.json"), busy = join(home, "busy.json");
  writeJson(raw, { events: [] });
  const normalized = cli("busy.ts", ["--in", raw], env);
  assert.equal(normalized.status, 0, normalized.stderr);
  writeFileSync(busy, normalized.stdout);
  const args = ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busy, "--now", new Date(NOW).toISOString()];
  const search = cli("slots.ts", [...args, "--from", "2026-10-29", "--to", "2026-10-29"], env);
  assert.equal(search.status, 0, search.stderr);
  assert.deepEqual(search.json.slots, []);
  assert.equal(search.json.incomplete.reason, "calendar-coverage");
  const exact = cli("slots.ts", [...args, "--at", "2026-10-29T10:00:00-03:00"], env);
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.json.free, false);
  assert.equal(exact.json.reason, "unknown");
});

test("unread explicit dates return incomplete coverage, not apparent unavailability", () => {
  const result = findSlots(q({ from: "2026-10-29", to: "2026-10-29",
    coverage: { from: "2026-09-28T00:00:00Z", to: "2026-10-12T00:00:00Z" } }));
  assert.deepEqual(result.slots, []);
  assert.ok(result.incomplete);
  assert.equal(result.incomplete.reason, "calendar-coverage");
  assert.equal(result.incomplete.requiredCoverage.from, "2026-10-29T03:00:00.000Z");
  assert.equal(result.incomplete.requiredCoverage.to, "2026-10-30T03:00:00.000Z");
});

test("typed weeks resolve in the owner's zone on Sunday and cannot carry substituted dates", () => {
  const query = q({ config: { ...CONFIG, timezone: "America/Los_Angeles" }, now: Date.parse("2026-10-05T02:12:33Z") });
  const next = resolveSearchConstraints({ days: ["mon", "tue", "wed"] }, "next", query.now, query.config.timezone);
  const result = findSlots({ ...query, ...next });
  assert.deepEqual(result.resolvedConstraints, { from: "2026-10-05", to: "2026-10-11", days: ["mon", "tue", "wed"] });
  assert.deepEqual(result.slots.map(s => s.start.slice(0, 10)), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.throws(() => resolveSearchConstraints({ from: "2026-10-12", to: "2026-10-14" }, "next", query.now, query.config.timezone), /week.*from.*to/i);
  assert.throws(() => resolveSearchConstraints({}, "later" as any, query.now, query.config.timezone), /week/);
  const current = findSlots({ ...query, ...resolveSearchConstraints({}, "this", query.now, query.config.timezone) });
  assert.deepEqual(current.resolvedConstraints, { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(current.slots, []);
});

test("ASAP ranks consecutive earliest starts today, retaining minimum notice and conflicts", () => {
  const query = q({ busy: [{ start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00" }] });
  const result = findSlots({ ...query, asap: true });
  assert.deepEqual(result.slots.map(s => s.start), [
    "2026-09-28T10:30:00-03:00", "2026-09-28T11:00:00-03:00", "2026-09-28T11:30:00-03:00",
  ]);
  for (const slot of result.slots) assert.equal(checkTime({ travel: { beforeMin: 0, afterMin: 0 }, ...query, start: slot.start }).free, true);
});

test("CLI searches an asked request using a typed next week", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ...CONFIG, timezone: "America/Los_Angeles" });
  writeJson(join(home, "busy.json"), { busy: [], coverage: { from: "2026-10-05T07:00:00Z", to: "2026-10-12T07:00:00Z" } });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, { travel: { beforeMin: 0, afterMin: 0 },
    status: "asked", origin: "owner", handle: "+15550107812", topic: "call", durationMin: 30,
    constraints: { days: ["mon", "tue", "wed"] }, offered: [],
  }, Date.parse("2026-10-05T02:12:33Z"), "asked-week"));
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", join(home, "busy.json"), "--request", "asked-week", "--week", "next", "--now", "2026-10-05T02:12:33Z"], { MEETLY_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, "2026-10-05T09:00:00-07:00");
  assert.equal(result.json.resolvedConstraints.to, "2026-10-11");
});

test("CLI next week replaces saved date bounds and retains non-date policy", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ...CONFIG, timezone: "UTC" });
  writeJson(join(home, "busy.json"), { busy: [], coverage });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    travel: { beforeMin: 0, afterMin: 0 }, status: "asked", origin: "owner", handle: "+15550107812", topic: "call", durationMin: 45, offered: [],
    constraints: { from: "2026-10-12", to: "2026-10-18", days: ["tue", "thu"], after: "13:00", before: "15:00", startTime: "13:15" },
  }, NOW, "saved-week"));
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", join(home, "busy.json"), "--request", "saved-week", "--week", "next", "--now", "2026-10-02T08:00:00Z"], { MEETLY_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.resolvedConstraints, { from: "2026-10-05", to: "2026-10-11", days: ["tue", "thu"], after: "13:00", before: "15:00", startTime: "13:15" });
  assert.deepEqual(result.json.slots.map((s: { start: string }) => s.start), ["2026-10-06T13:15:00+00:00", "2026-10-08T13:15:00+00:00"]);
  assert.equal(result.json.durationMin, 45);
});

test("typed meal defaults and saved exact owner starts survive slot planning", () => {
  for (const meal of ["lunch", "dinner", "coffee"] as const) {
    const query = { ...q(), durationMin: undefined, meal };
    const slot = findSlots(query).slots[0]!;
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), (meal === "coffee" ? 30 : 60) * 60_000);
    assert.equal(checkTime({ ...query, start: slot.start }).free, true);
  }
  const slots = findSlots(q({ meal: "dinner", startTime: "17:15", durationMin: 90 })).slots;
  assert.ok(slots.length);
  assert.ok(slots.every(slot => slot.start.slice(11, 16) === "17:15" && slot.end.slice(11, 16) === "18:45"));
});

test("request CLI re-offers retain saved excluded weekdays", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  writeJson(join(home, "busy.json"), { busy: [], coverage });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    travel: { beforeMin: 0, afterMin: 0 }, origin: "owner", status: "asked", handle: "+15550107812", topic: "Call", durationMin: 30,
    constraints: { days: ["mon", "tue"] }, excludedDays: ["mon"], offered: [],
  }, NOW, "excluded"));
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", join(home, "busy.json"), "--request", "excluded", "--now", new Date(NOW).toISOString()], { MEETLY_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.json.slots.length);
  assert.ok(result.json.slots.every((s: { dayOfWeek: string }) => s.dayOfWeek === "tue"), JSON.stringify(result.json));
});

test("travel must fit on both sides while only the meeting must fit the working window", () => {
  const query = q({ now: NOW - 86400000, config: { ...CONFIG, horizonDays: 1 }, format: "in_person", travel: { beforeMin: 45, afterMin: 30 } });
  const first = findSlots(query).slots[0]!;
  assert.equal(first.start.slice(11, 16), CONFIG.windowStart);
  for (const busy of [
    { start: "2026-09-28T08:00:00-03:00", end: "2026-09-28T08:30:00-03:00" },
    { start: "2026-09-28T09:45:00-03:00", end: "2026-09-28T10:00:00-03:00" },
  ]) {
    assert.equal(checkTime({ travel: { beforeMin: 0, afterMin: 0 }, ...query, start: first.start, busy: [busy] }).reason, "busy");
    assert.ok(findSlots({ ...query, busy: [busy] }).slots.every(s => s.start !== first.start));
  }
  assert.equal(checkTime({ travel: { beforeMin: 0, afterMin: 0 }, ...query, start: first.start, unknownAfter: first.end }).reason, "unknown");
  assert.equal(checkTime({ ...query, travel: { beforeMin: 0, afterMin: 0 }, start: first.start, busy: [], format: "meet", unknownAfter: first.end }).free, true);
});

test("slots --request ignores its booked travel, preserves minutes, and conceals private fields", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const request = { id: "travel", status: "booked", durationMin: 30, format: "in_person", travel: { beforeMin: 45, afterMin: 20 },
    travelEvents: [{ holdId: "private-travel", account: "owner@example.com" }], offered: [] };
  writeJson(join(home, "ledger.json"), { requests: [request] });
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { coverage, busy: [{ id: "private-travel", account: "owner@example.com", start: "2026-09-28T08:30:00-03:00", end: "2026-09-28T09:00:00-03:00" }], degraded: [] });
  const args = ["--request", "travel", "--in", busyFile, "--at", "2026-09-28T09:00:00-03:00", "--now", new Date(NOW - 86400000).toISOString()];
  const own = cli("slots.ts", args, { MEETLY_HOME: home });
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.json.free, true);
  assert.doesNotMatch(own.stdout, /private-travel|beforeMin|owner@example/);
  writeJson(busyFile, { coverage, busy: [{ id: "other", account: "owner@example.com", start: "2026-09-28T08:30:00-03:00", end: "2026-09-28T09:00:00-03:00" }], degraded: [] });
  const other = cli("slots.ts", args, { MEETLY_HOME: home });
  assert.equal(other.json.reason, "busy");
});

test("replacement search honors an explicit format change with its travel estimate", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  writeJson(join(home, "ledger.json"), {requests: [{id: "change", status: "booked", format: "meet", durationMin: 30,
    travel: {beforeMin: 0, afterMin: 0}, offered: []}]});
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, {coverage, busy: [{start: "2026-09-28T09:45:00-03:00", end: "2026-09-28T10:00:00-03:00"}], degraded: []});
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--request", "change", "--in", busyFile, "--now", new Date(NOW).toISOString(),
    "--at", "2026-09-28T10:00:00-03:00", "--format", "in_person", "--travel", '{"beforeMin":25,"afterMin":25}'], {MEETLY_HOME: home});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.free, false);
  assert.equal(result.json.reason, "busy");
});

test("exact-time checks and searches reject travel outside fetched coverage", () => {
  const coverage = { from: "2026-09-28T09:00:00-03:00", to: "2026-09-28T13:00:00-03:00" };
  const query = q({ coverage, travel: { beforeMin: 20, afterMin: 20 } });
  for (const start of ["2026-09-28T09:00:00-03:00", "2026-09-28T12:30:00-03:00", "2026-10-01T12:00:00-03:00"]) {
    assert.equal(checkTime({ ...query, start }).reason, "unknown");
  }
  assert.equal(checkTime({ ...query, start: "2026-09-28T11:30:00-03:00" }).free, true);
  assert.ok(findSlots(query).slots.every(s => s.start.slice(0, 10) === "2026-09-28" && s.end <= coverage.to));
});

test("an owner-approved clock time replaces the meal window without constraining travel", () => {
  const query = q({ meal: "lunch", durationMin: 60, startTime: "11:00",
    travel: { beforeMin: 15, afterMin: 15 } });
  const checked = checkTime({ ...query, start: "2026-09-28T11:00:00-03:00" });
  assert.equal(checked.outsideHours, false);
  assert.equal(checked.free, true);
  const found = findSlots(query).slots;
  assert.ok(found.length);
  assert.ok(found.every(slot => slot.start.slice(11, 16) === "11:00"));
  assert.equal(checkTime({ ...query, startTime: undefined, start: checked.slot.start }).outsideHours, true);
  assert.equal(checkTime({ ...query, start: checked.slot.start,
    busy: [{ start: "2026-09-28T10:50:00-03:00", end: "2026-09-28T10:55:00-03:00" }] }).free, false);
});

for (const format of ["meet", "in_person"] as const) test(`held replacement exact-time check uses its ${format} format and travel`, () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const start = "2026-09-28T11:00:00-03:00";
  const replacement = { format, travel: format === "meet" ? { beforeMin: 0, afterMin: 0 } : { beforeMin: 30, afterMin: 30 } };
  const request = { id: "replacement", status: "booked", durationMin: 30, format: format === "meet" ? "in_person" : "meet",
    travel: format === "meet" ? { beforeMin: 30, afterMin: 30, override: true } : { beforeMin: 0, afterMin: 0 },
    bookedReplacement: true, replacement, offered: [{ start, end: "2026-09-28T11:30:00-03:00", holdId: "held", account: "jean@example.com" }] };
  const path = join(home, "ledger.json"), busyFile = join(home, "busy.json");
  writeJson(path, { requests: [request] });
  writeJson(busyFile, { coverage, busy: [{ id: "other", account: "jean@example.com", start: "2026-09-28T10:00:00-03:00", end: start }], degraded: [] });
  const args = ["--request", request.id, "--in", busyFile, "--now", new Date(NOW).toISOString(), "--at"];
  const checked = cli("slots.ts", [...args, "2026-09-28T11:00"], { MEETLY_HOME: home });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.free, format === "meet");
  assert.doesNotMatch(checked.stdout, /beforeMin|afterMin|jean@example/);
  const unheld = cli("slots.ts", [...args, "2026-09-28T11:15:00-03:00"], { MEETLY_HOME: home });
  assert.equal(unheld.json.free, format !== "meet", "unheld times use the active booking");
  writeJson(path, { requests: [{ ...request, bookedReplacement: false }] });
  const inactive = cli("slots.ts", [...args, start], { MEETLY_HOME: home });
  assert.equal(inactive.json.free, format !== "meet", "inactive proposals cannot determine the check");
});

test("exact starts preserve fractional owner-zone times", () => {
  const checked = checkTime({ ...q(), start: "2026-10-05T10:00:01.25" });
  assert.equal(checked.slot.start, "2026-10-05T10:00:01.250-03:00");
  assert.equal(Date.parse(checked.slot.start), Date.parse("2026-10-05T13:00:01.250Z"));
  assert.equal(Date.parse(checked.slot.end) - Date.parse(checked.slot.start), q().config.durationMin * 60_000);
});
