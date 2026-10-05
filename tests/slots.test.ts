import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Config } from "../skills/meetly/scripts/config.ts";
import { checkTime, findSlots, type SlotQuery } from "../skills/meetly/scripts/slots.ts";
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
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ travel: { beforeMin: 0, afterMin: 0 }, now: NOW, config: CONFIG, busy: [], ...over });
const starts = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.start);
const labels = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.label);

test("no busy: spread over the first days, after the minimum notice", () => {
  const { slots, unknownAfter } = findSlots(q());
  assert.deepEqual(slots, [
    { start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00", dayOfWeek: "mon", label: "mon 28/9 10:00" },
    { start: "2026-09-29T09:00:00-03:00", end: "2026-09-29T09:30:00-03:00", dayOfWeek: "tue", label: "tue 29/9 09:00" },
    { start: "2026-09-30T09:00:00-03:00", end: "2026-09-30T09:30:00-03:00", dayOfWeek: "wed", label: "wed 30/9 09:00" },
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
  assert.deepEqual(labels({ now: Date.parse("2026-10-02T17:00:00-03:00") }), ["mon 5/10 09:00", "tue 6/10 09:00", "wed 7/10 09:00"]);
});

test("request days intersect the config days and after narrows the window", () => {
  assert.deepEqual(labels({ days: ["thu"], after: "13:00" }), ["thu 1/10 13:00", "thu 1/10 13:30", "thu 1/10 14:00"]);
  assert.deepEqual(labels({ days: ["thu"], after: "13:10", before: "14:00" }), ["thu 1/10 13:30"]);
});

test("requests only narrow the configured days and window", () => {
  assert.deepEqual(starts({ days: ["sat"] }), []);
  assert.deepEqual(starts({ days: ["mon"], after: "19:00", before: "21:00" }), []);
  assert.deepEqual(labels({ after: "07:00", before: "09:30", count: 2 }), ["tue 29/9 09:00", "wed 30/9 09:00"]);
});

test("excluded starts are not offered", () => {
  assert.equal(starts({ exclude: ["2026-09-28T13:00:00.000Z"] })[0], "2026-09-28T10:30:00-03:00");
});

test("nothing is offered past the end of what was read", () => {
  const r = findSlots(q({ unknownAfter: "2026-09-29T09:15:00-03:00" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 28/9 10:00", "mon 28/9 10:30", "mon 28/9 11:00"]);
  assert.equal(r.unknownAfter, "2026-09-29T09:15:00-03:00");
});

test("a date range narrows a longer horizon", () => {
  const config = { ...CONFIG, horizonDays: 14 };
  const r = findSlots(q({ config, from: "2026-10-05", to: "2026-10-06" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 5/10 09:00", "mon 5/10 09:30", "tue 6/10 09:00"]);
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
  const r = findSlots({ travel: { beforeMin: 0, afterMin: 0 }, now: Date.parse("2026-10-30T12:00:00-07:00"), config, busy: [], durationMin: 60 });
  assert.deepEqual(r.slots.map((s) => s.start), [
    "2026-10-31T09:00:00-07:00",
    "2026-11-01T09:00:00-08:00",
    "2026-11-02T09:00:00-08:00",
  ]);
});

test("labels follow the other person's locale", () => {
  assert.deepEqual(labels({ locale: "pt-BR" }), ["seg., 28/09, 10:00", "ter., 29/09, 09:00", "qua., 30/09, 09:00"]);
  assert.deepEqual(labels({ locale: "en-US", count: 1 }), ["Mon, 9/28, 10:00 AM"]);
  assert.deepEqual(labels({ locale: "de-DE", count: 1 }), ["Mo., 28.9., 10:00"]);
  assert.equal(findSlots(q({ locale: "en-US" })).slots[0]!.dayOfWeek, "mon");
  assert.throws(() => findSlots(q({ locale: "not a locale!" })), /unknown locale/);
});

test("the CLI reads busy.ts output and the stored config", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeFileSync(busyFile, JSON.stringify({
    busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }],
    degraded: ["other@example.com"],
  }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00"];
  const r = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slots[0].start, "2026-09-28T11:00:00-03:00");
  assert.deepEqual(r.json.degraded, ["other@example.com"]);
  const oversized = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--count", "6"], env);
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.deepEqual(oversized.json, r.json);
  const allowed = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--allow-overlap", '{"account":"jean@example.com","id":"weekly"}', "--count", "1"], env);
  assert.deepEqual(allowed.json.slots.map((s: { label: string }) => s.label), ["mon 28/9 10:00"]);
  const at = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--at", "2026-10-03T10:00:00-03:00", "--duration", "60", "--locale", "pt-BR"], env);
  assert.equal(at.status, 0, at.stderr);
  assert.deepEqual(at.json, {
    slot: { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T11:00:00-03:00", dayOfWeek: "sat", label: "sáb., 03/10, 10:00" },
    free: true,
    outsideHours: true,
    degraded: ["other@example.com"],
  });
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--at", "2026-10-03T10:00:00-03:00", "--days", "sat"], env).status, 1);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--owner"], env).status, 1);
  const authorizedFile = join(home, "authorized-busy.json");
  writeJson(authorizedFile, { busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly", account: "jean@example.com" }], allowOverlap: [{ account: "jean@example.com", id: "weekly" }] });
  const authorized = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", authorizedFile, ...now, "--count", "1"], env);
  assert.deepEqual(authorized.json.slots, allowed.json.slots);
  assert.equal(cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", authorizedFile, ...now, "--at", "2026-09-28T10:00:00-03:00"], env).json.free, true);
  assert.doesNotMatch(authorized.stdout, /weekly|allowOverlap/);
  const us = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, ...now, "--locale", "en-US", "--count", "1"], env);
  assert.deepEqual(us.json.slots.map((s: { label: string }) => s.label), ["Mon, 9/28, 11:00 AM"]);
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
    writeJson(busyFile, { busy: [...busy, ...extra], degraded: [] });
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
    checkTime({ travel: { beforeMin: 0, afterMin: 0 }, now: NOW, config: CONFIG, busy: [], start, ...over });
  assert.deepEqual(check("2026-09-28T10:00:00-03:00"), {
    slot: { start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00", dayOfWeek: "mon", label: "mon 28/9 10:00" },
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
  assert.equal(check("2026-10-03T10:00:00-03:00", { locale: "en-US" }).slot.label, "Sat, 10/3, 10:00 AM");
  assert.equal(check("2026-10-03T10:00").slot.start, "2026-10-03T10:00:00-03:00");
  assert.throws(() => check("someday"), /not a time/);
});

test("replacement slot search keeps saved and newly resolved overlap authorizations private", () => {
  const home = tmpHome(), env = { MEETLY_HOME: home };
  writeJson(join(home, "config.json"), CONFIG);
  const start = "2026-09-28T10:00:00-03:00", end = "2026-09-28T10:30:00-03:00";
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    origin: "owner", chatUid: "group", handle: "+15551234567", topic: "Lunch", durationMin: 30,
    allowOverlap: [{ account: "jean@example.com", id: "saved" }], offered: [{ start, end, holdId: "own-hold", account: "jean@example.com" }],
  }, Date.parse(start), "r_one"));
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { busy: ["saved", "new", "own-hold"].map(id => ({ id, start, end, account: "jean@example.com" })), allowOverlap: [{ account: "jean@example.com", id: "new" }] });
  const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--after", "10:00", "--count", "1"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.slots[0].start, start);
  assert.doesNotMatch(result.stdout, /saved|new|own-hold|allowOverlap/);
  const alternatives = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--request", "r_one", "--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--near", start, "--no-overlap"], env);
  assert.equal(alternatives.status, 0, alternatives.stderr);
  assert.equal(alternatives.json.slots[0].start, end);

});

test("lunch and dinner override working hours; coffee keeps the owner's window and 30-minute default", () => {
  const query = q({ config: { ...CONFIG, windowEnd: "11:00" }, meal: "lunch" });
  assert.equal(findSlots(query).slots[0]!.start, "2026-09-28T11:30:00-03:00");
  const dinner = { ...query, meal: "dinner" as const, travel: { beforeMin: 15, afterMin: 15 }, after: "19:00", before: "21:00", days: ["mon"] as const,
    busy: [{ start: "2026-09-28T19:00:00-03:00", end: "2026-09-28T20:00:00-03:00" }] };
  const slots = findSlots({ ...dinner, days: [...dinner.days] }).slots;
  assert.deepEqual(slots.map(s => s.start), ["2026-10-05T19:00:00-03:00", "2026-10-05T19:30:00-03:00", "2026-10-05T20:00:00-03:00"]);
  assert.equal(checkTime({ ...query, meal: "dinner", start: slots[0]!.start }).outsideHours, false);
  assert.equal(checkTime({ ...query, meal: "dinner", start: "2026-09-28T21:00:00-03:00" }).outsideHours, true);
  assert.deepEqual(findSlots({ ...query, meal: "dinner", days: ["sat"] }).slots, []);
  const coffee = q({ config: { ...CONFIG, durationMin: 45, windowStart: "17:00", windowEnd: "19:00" }, meal: "coffee" });
  const first = findSlots(coffee).slots[0]!;
  assert.equal(first.start, "2026-09-28T17:00:00-03:00");
  assert.equal(Date.parse(first.end) - Date.parse(first.start), 30 * 60_000);
  assert.equal(checkTime({ ...coffee, start: "2026-09-28T18:30:00-03:00" }).outsideHours, false);
  assert.equal(checkTime({ ...coffee, start: "2026-09-28T09:00:00-03:00" }).outsideHours, true);
});

for (const meal of ["lunch", "dinner", "coffee"] as const) {
  const defaultDuration = meal === "coffee" ? 30 : 60;
  test(`the CLI defaults ${meal} to ${defaultDuration} minutes for searches and exact times, with explicit duration taking precedence`, () => {
    const home = tmpHome();
    writeJson(join(home, "config.json"), { ...CONFIG, durationMin: 45 });
    const busyFile = join(home, "busy.json");
    writeJson(busyFile, { busy: [], degraded: [] });
    const args = ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--meal", meal];
    const start = meal === "lunch" ? "2026-09-28T11:30:00-03:00" : meal === "dinner" ? "2026-09-28T18:00:00-03:00" : "2026-09-28T10:00:00-03:00";
    for (const mode of [[], ["--at", start]]) {
      for (const duration of [undefined, 45]) {
        const result = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', ...args, ...mode, ...(duration === undefined ? [] : ["--duration", String(duration)])], { MEETLY_HOME: home });
        assert.equal(result.status, 0, result.stderr);
        const slot = mode.length ? result.json.slot : result.json.slots[0];
        assert.equal(slot.start, start);
        assert.equal((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000, duration ?? defaultDuration);
        if (!mode.length) assert.equal(result.json.durationMin, duration ?? defaultDuration);
      }
    }
    writeJson(busyFile, { busy: [{
      start: new Date(Date.parse(start) + (defaultDuration - 15) * 60_000).toISOString(),
      end: new Date(Date.parse(start) + 60 * 60_000).toISOString(),
    }], degraded: [] });
    const blocked = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', ...args, "--at", start], { MEETLY_HOME: home });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(blocked.json.reason, "busy");
  });
}

test("the CLI accepts coffee and preserves dinner's window and saved duration on saved-request searches", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { busy: [], degraded: [] });
  const args = ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--duration", "45"];
  const first = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', ...args, "--meal", "dinner"], { MEETLY_HOME: home });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.slots[0].start, "2026-09-28T18:00:00-03:00");
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    origin: "owner", handle: "+15551234567", topic: "dinner", meal: "dinner", durationMin: 45,
    offered: first.json.slots.map((s: object) => ({ ...s, account: CONFIG.defaultAccount })),
  }, NOW, "dinner"));
  const again = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--now", new Date(NOW).toISOString(), "--request", "dinner", "--after", "19:00"], { MEETLY_HOME: home });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.slots[0].start, "2026-09-28T19:00:00-03:00");
  assert.equal(again.json.slots[0].end, "2026-09-28T19:45:00-03:00");
  const coffee = cli("slots.ts", ["--travel", '{"beforeMin":0,"afterMin":0}', "--in", busyFile, "--now", new Date(NOW).toISOString(), "--meal", "coffee", "--after", "17:00"], { MEETLY_HOME: home });
  assert.equal(coffee.status, 0, coffee.stderr);
  assert.equal(coffee.json.slots[0].start, "2026-09-28T17:00:00-03:00");
  assert.equal(coffee.json.slots[0].end, "2026-09-28T17:30:00-03:00");
});

test("travel must fit on both sides while only the meeting must fit the working window", () => {
  const query = q({ now: NOW - 86400000, config: { ...CONFIG, horizonDays: 1 }, format: "in_person", travel: { beforeMin: 45, afterMin: 30 } });
  const first = findSlots(query).slots[0]!;
  assert.equal(first.start.slice(11, 16), CONFIG.windowStart);
  for (const busy of [
    { start: "2026-09-28T08:00:00-03:00", end: "2026-09-28T08:30:00-03:00" },
    { start: "2026-09-28T09:45:00-03:00", end: "2026-09-28T10:00:00-03:00" },
  ]) {
    assert.equal(checkTime({ ...query, start: first.start, busy: [busy] }).reason, "busy");
    assert.ok(findSlots({ ...query, busy: [busy] }).slots.every(s => s.start !== first.start));
  }
  assert.equal(checkTime({ ...query, start: first.start, unknownAfter: first.end }).reason, "unknown");
  assert.equal(checkTime({ ...query, travel: { beforeMin: 0, afterMin: 0 }, start: first.start, busy: [], format: "meet", unknownAfter: first.end }).free, true);
});

test("slots --request ignores its booked travel, preserves minutes, and conceals private fields", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const request = { id: "travel", status: "booked", durationMin: 30, format: "in_person", travel: { beforeMin: 45, afterMin: 20 },
    travelEvents: [{ holdId: "private-travel", account: "owner@example.com" }], offered: [] };
  writeJson(join(home, "ledger.json"), { requests: [request] });
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, { busy: [{ id: "private-travel", account: "owner@example.com", start: "2026-09-28T08:30:00-03:00", end: "2026-09-28T09:00:00-03:00" }], degraded: [] });
  const args = ["--request", "travel", "--in", busyFile, "--at", "2026-09-28T09:00:00-03:00", "--now", new Date(NOW - 86400000).toISOString()];
  const own = cli("slots.ts", args, { MEETLY_HOME: home });
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.json.free, true);
  assert.doesNotMatch(own.stdout, /private-travel|beforeMin|owner@example/);
  writeJson(busyFile, { busy: [{ id: "other", account: "owner@example.com", start: "2026-09-28T08:30:00-03:00", end: "2026-09-28T09:00:00-03:00" }], degraded: [] });
  const other = cli("slots.ts", args, { MEETLY_HOME: home });
  assert.equal(other.json.reason, "busy");
});

test("replacement search honors an explicit format change with its travel estimate", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  writeJson(join(home, "ledger.json"), {requests: [{id: "change", status: "booked", format: "meet", durationMin: 30,
    travel: {beforeMin: 0, afterMin: 0}, offered: []}]});
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, {busy: [{start: "2026-09-28T09:45:00-03:00", end: "2026-09-28T10:00:00-03:00"}], degraded: []});
  const result = cli("slots.ts", ["--request", "change", "--in", busyFile, "--now", new Date(NOW).toISOString(),
    "--at", "2026-09-28T10:00:00-03:00", "--format", "in_person", "--travel", '{"beforeMin":25,"afterMin":25}'], {MEETLY_HOME: home});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.free, false);
  assert.equal(result.json.reason, "busy");
});

test("only a known busy exact-time check routes the model to private inspection", () => {
  const home = tmpHome(), busyFile = join(home, "busy.json");
  writeJson(join(home, "config.json"), CONFIG);
  const start = "2026-09-28T10:00:00-03:00";
  const busy = [{ start, end: "2026-09-28T11:00:00-03:00", id: "private-id", account: "private-account" }];
  const args = ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--at", start, "--format", "phone", "--travel", '{"beforeMin":0,"afterMin":0}'];
  for (const [input, guided] of [
    [{ busy, degraded: [] }, true],
    [{ busy: [], degraded: [] }, false],
    [{ busy, degraded: ["unread"] }, false],
    [{ busy, degraded: [], unknownAfter: start }, false],
  ] as const) {
    writeJson(busyFile, input);
    const result = cli("slots.ts", args, { MEETLY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(!!result.json.next, guided);
    if (guided) {
      assert.match(result.json.next.ownerMainDM, /meetly_movable/);
      assert.match(result.json.next.otherChats, /alternatives/);
      assert.doesNotMatch(JSON.stringify(result.json.next), /private-id|private-account/);
    }
  }
  writeJson(busyFile, { busy, degraded: [] });
  const soon = cli("slots.ts", [...args, "--now", start], { MEETLY_HOME: home });
  assert.equal(soon.json.reason, "too-soon");
  assert.equal(soon.json.next, undefined);
});
