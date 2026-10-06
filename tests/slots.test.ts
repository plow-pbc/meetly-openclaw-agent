import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Config } from "../skills/meetly/scripts/config.ts";
import { checkTime, findSlots, resolveSearchConstraints, type SlotQuery } from "../skills/meetly/scripts/slots.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
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
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ now: NOW, config: CONFIG, durationMin: 30, busy: [], coverage, ...over });
const starts = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.start);
const labels = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.label);

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
    degraded: ["other@example.com"], coverage,
  }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00", "--duration", "30"];
  const r = cli("slots.ts", ["--in", busyFile, ...now], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slots[0].start, "2026-09-28T11:00:00-03:00");
  assert.deepEqual(r.json.degraded, ["other@example.com"]);
  const oversized = cli("slots.ts", ["--in", busyFile, ...now, "--count", "6"], env);
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.deepEqual(oversized.json, r.json);
  const allowed = cli("slots.ts", ["--in", busyFile, ...now, "--allow-overlap", '{"account":"jean@example.com","id":"weekly"}', "--count", "1"], env);
  assert.deepEqual(allowed.json.slots.map((s: { label: string }) => s.label), ["mon 28/9 10:00 America/Sao_Paulo"]);
  const at = cli("slots.ts", ["--in", busyFile, ...now.slice(0, 2), "--at", "2026-10-03T10:00:00-03:00", "--duration", "60", "--locale", "pt-BR"], env);
  assert.equal(at.status, 0, at.stderr);
  assert.deepEqual(at.json, {
    slot: { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T11:00:00-03:00", dayOfWeek: "sat", label: "sáb., 03/10, 10:00 BRT" },
    free: true,
    outsideHours: true,
    degraded: ["other@example.com"],
  });
  assert.equal(cli("slots.ts", ["--in", busyFile, "--at", "2026-10-03T10:00:00-03:00", "--days", "sat"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--owner"], env).status, 1);
  const authorizedFile = join(home, "authorized-busy.json");
  writeJson(authorizedFile, { coverage, busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }], allowOverlap: [{ account: "jean@example.com", id: "weekly" }] });
  const authorized = cli("slots.ts", ["--in", authorizedFile, ...now, "--count", "1"], env);
  assert.deepEqual(authorized.json.slots, allowed.json.slots);
  assert.equal(cli("slots.ts", ["--in", authorizedFile, ...now, "--at", "2026-09-28T10:00:00-03:00"], env).json.free, true);
  assert.doesNotMatch(authorized.stdout, /weekly|allowOverlap/);
  const us = cli("slots.ts", ["--in", busyFile, ...now, "--locale", "en-US", "--count", "1"], env);
  assert.deepEqual(us.json.slots.map((s: { label: string }) => s.label), ["Mon, 9/28, 11:00 AM GMT-3"]);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--locale", "??"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--days", "someday"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--from", "5/10"], env).status, 1);
  const boundedArgs = ["--in", busyFile, ...now, "--duration", "30", "--days", "mon",
    "--from", "2026-09-28", "--to", "2026-09-28", "--after", "10:00", "--before", "14:00"];
  const nearCases: [string, string[] | null][] = [
    ["2026-09-28T10:30:00-03:00", ["11:00", "11:30", "12:00"]],
    ["2026-09-28T13:30:00-03:00", ["13:30", "13:00", "12:30"]],
    ["tomorrow", null],
  ];
  for (const [near, expected] of nearCases) {
    const result = cli("slots.ts", [...boundedArgs, "--near", near], env);
    assert.equal(result.status, expected ? 0 : 1, result.stderr);
    if (expected) assert.deepEqual(result.json.slots.map((s: { start: string }) => s.start),
      expected.map(time => `2026-09-28T${time}:00-03:00`));
  }
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
    origin: "owner", handle: "+15550107812", topic: "lunch", durationMin: 30, offered,
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
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    origin: "owner", chatUid: "group", handle: "+15551234567", topic: "Lunch", durationMin: 60,
    allowOverlap: [{ account: "jean@example.com", id: "saved" }], offered: [{ start, end, holdId: "own-hold", account: "jean@example.com" }],
  }, Date.parse(start), "r_one"));
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { coverage, busy: ["saved", "new", "own-hold"].map(id => ({ id, start, end, account: "jean@example.com" })), allowOverlap: [{ account: "jean@example.com", id: "new" }] });
  const result = cli("slots.ts", ["--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--after", "10:00", "--count", "1"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, start);
  assert.doesNotMatch(result.stdout, /saved|new|own-hold|allowOverlap/);
  const args = ["--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--at", start];
  const checked = cli("slots.ts", args, env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.free, true);
  assert.equal(checked.json.slot.end, end);
  const approval = cli("slots.ts", [...args, "--no-overlap"], env);
  assert.equal(approval.status, 0, approval.stderr);
  assert.equal(approval.json.free, false);
  assert.equal(approval.json.reason, "busy");
  const alternatives = cli("slots.ts", ["--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--near", start, "--no-overlap"], env);
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
  const checked = checkTime({ ...query, start: slot.start });
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
  const args = ["--in", busy, "--now", new Date(NOW).toISOString()];
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
  for (const slot of result.slots) assert.equal(checkTime({ ...query, start: slot.start }).free, true);
});

test("CLI searches an asked request using a typed next week", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ...CONFIG, timezone: "America/Los_Angeles" });
  writeJson(join(home, "busy.json"), { busy: [], coverage: { from: "2026-10-05T07:00:00Z", to: "2026-10-12T07:00:00Z" } });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    status: "asked", origin: "owner", handle: "+15550107812", topic: "call", durationMin: 30,
    constraints: { days: ["mon", "tue", "wed"] }, offered: [],
  }, Date.parse("2026-10-05T02:12:33Z"), "asked-week"));
  const result = cli("slots.ts", ["--in", join(home, "busy.json"), "--request", "asked-week", "--week", "next", "--now", "2026-10-05T02:12:33Z"], { MEETLY_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, "2026-10-05T09:00:00-07:00");
  assert.equal(result.json.resolvedConstraints.to, "2026-10-11");
});

test("CLI next week replaces saved date bounds and retains non-date policy", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ...CONFIG, timezone: "UTC" });
  writeJson(join(home, "busy.json"), { busy: [], coverage });
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    status: "asked", origin: "owner", handle: "+15550107812", topic: "call", durationMin: 45, offered: [],
    constraints: { from: "2026-10-12", to: "2026-10-18", days: ["tue", "thu"], after: "13:00", before: "15:00", startTime: "13:15" },
  }, NOW, "saved-week"));
  const result = cli("slots.ts", ["--in", join(home, "busy.json"), "--request", "saved-week", "--week", "next", "--now", "2026-10-02T08:00:00Z"], { MEETLY_HOME: home });
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
    origin: "owner", status: "asked", handle: "+15550107812", topic: "Call", durationMin: 30,
    constraints: { days: ["mon", "tue"] }, excludedDays: ["mon"], offered: [],
  }, NOW, "excluded"));
  const result = cli("slots.ts", ["--in", join(home, "busy.json"), "--request", "excluded", "--now", new Date(NOW).toISOString()], { MEETLY_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.json.slots.length);
  assert.ok(result.json.slots.every((s: { dayOfWeek: string }) => s.dayOfWeek === "tue"), JSON.stringify(result.json));
});
