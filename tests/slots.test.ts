import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
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
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ now: NOW, config: CONFIG, busy: [], ...over });
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

test("busy time is skipped unless its event may be overlapped", () => {
  const busy = [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly" }];
  assert.equal(starts({ busy })[0], "2026-09-28T11:00:00-03:00");
  assert.equal(starts({ busy, allowOverlap: ["weekly"] })[0], "2026-09-28T10:00:00-03:00");
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
  const r = findSlots({ now: Date.parse("2026-10-30T12:00:00-07:00"), config, busy: [], durationMin: 60 });
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
    busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly" }],
    degraded: ["other@example.com"],
  }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00"];
  const r = cli("slots.ts", ["--in", busyFile, ...now], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slots[0].start, "2026-09-28T11:00:00-03:00");
  assert.deepEqual(r.json.degraded, ["other@example.com"]);
  const allowed = cli("slots.ts", ["--in", busyFile, ...now, "--allow-overlap", "weekly", "--count", "1"], env);
  assert.deepEqual(allowed.json.slots.map((s: { label: string }) => s.label), ["mon 28/9 10:00"]);
  const at = cli("slots.ts", ["--in", busyFile, ...now, "--at", "2026-10-03T10:00:00-03:00", "--duration", "60", "--locale", "pt-BR"], env);
  assert.equal(at.status, 0, at.stderr);
  assert.deepEqual(at.json, {
    slot: { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T11:00:00-03:00", dayOfWeek: "sat", label: "sáb., 03/10, 10:00" },
    free: true,
    outsideHours: true,
    degraded: ["other@example.com"],
  });
  assert.equal(cli("slots.ts", ["--in", busyFile, "--at", "2026-10-03T10:00:00-03:00", "--days", "sat"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--owner"], env).status, 1);
  const authorizedFile = join(home, "authorized-busy.json");
  writeJson(authorizedFile, { busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly" }], allowOverlap: ["weekly"] });
  const authorized = cli("slots.ts", ["--in", authorizedFile, ...now, "--count", "1"], env);
  assert.deepEqual(authorized.json.slots, allowed.json.slots);
  assert.equal(cli("slots.ts", ["--in", authorizedFile, ...now, "--at", "2026-09-28T10:00:00-03:00"], env).json.free, true);
  assert.doesNotMatch(authorized.stdout, /weekly|allowOverlap/);
  const us = cli("slots.ts", ["--in", busyFile, ...now, "--locale", "en-US", "--count", "1"], env);
  assert.deepEqual(us.json.slots.map((s: { label: string }) => s.label), ["Mon, 9/28, 11:00 AM"]);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--locale", "??"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--days", "someday"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--from", "5/10"], env).status, 1);
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
    checkTime({ now: NOW, config: CONFIG, busy: [], start, ...over });
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
  const busy = [{ start: "2026-10-03T12:30:00.000Z", end: "2026-10-03T13:30:00.000Z", id: "gym" }];
  assert.deepEqual(
    [check("2026-10-03T10:00:00-03:00", { busy }).free, check("2026-10-03T10:00:00-03:00", { busy }).reason],
    [false, "busy"],
  );
  assert.equal(check("2026-10-03T10:00:00-03:00", { busy, allowOverlap: ["gym"] }).free, true);
  assert.equal(check("2026-09-28T09:00:00-03:00").reason, "too-soon");
  assert.equal(check("2026-10-03T10:00:00-03:00", { unknownAfter: "2026-10-02T00:00:00-03:00" }).reason, "unknown");
  assert.equal(check("2026-10-03T10:00:00-03:00", { locale: "en-US" }).slot.label, "Sat, 10/3, 10:00 AM");
  assert.equal(check("2026-10-03T10:00").slot.start, "2026-10-03T10:00:00-03:00");
  assert.throws(() => check("someday"), /not a time/);
});


test("a busy requested time yields nearest permitted alternatives through the CLI", t => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeJson(busyFile, {
    busy: [{ id: "commitment", start: "2026-09-28T11:30:00-03:00", end: "2026-09-28T12:30:00-03:00" }],
    unknownAfter: "2026-09-28T14:00:00-03:00", degraded: [],
  });
  const args = ["--in", busyFile, "--now", "2026-09-28T08:00:00-03:00", "--duration", "30",
    "--days", "mon", "--from", "2026-09-28", "--to", "2026-09-28", "--after", "11:00", "--before", "15:00"];
  const env = { MEETLY_HOME: home };
  const result = cli("slots.ts", [...args, "--near", "2026-09-28T11:30:00-03:00"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.slots.map((s: { start: string }) => s.start), [
    "2026-09-28T11:00:00-03:00", "2026-09-28T12:30:00-03:00", "2026-09-28T13:00:00-03:00",
  ]);
  const later = cli("slots.ts", [...args, "--near", "2026-09-28T13:30:00-03:00"], env);
  assert.deepEqual(later.json.slots.map((s: { start: string }) => s.start), [
    "2026-09-28T13:30:00-03:00", "2026-09-28T13:00:00-03:00", "2026-09-28T12:30:00-03:00",
  ]);
  assert.equal(cli("slots.ts", [...args, "--near", "tomorrow"], env).status, 1);
});

test("lunch and dinner override working hours; coffee keeps the owner's window and 30-minute default", () => {
  const query = q({ config: { ...CONFIG, windowEnd: "11:00" }, meal: "lunch" });
  assert.equal(findSlots(query).slots[0]!.start, "2026-09-28T11:30:00-03:00");
  const dinner = { ...query, meal: "dinner" as const, after: "19:00", before: "21:00", days: ["mon"] as const,
    busy: [{ start: "2026-09-28T19:00:00-03:00", end: "2026-09-28T20:00:00-03:00" }] };
  const slots = findSlots({ ...dinner, days: [...dinner.days] }).slots;
  assert.deepEqual(slots.map(s => s.start), ["2026-09-28T20:00:00-03:00", "2026-10-05T19:00:00-03:00", "2026-10-05T19:30:00-03:00"]);
  assert.equal(checkTime({ ...query, meal: "dinner", start: slots[0]!.start }).outsideHours, false);
  assert.equal(checkTime({ ...query, meal: "dinner", start: "2026-09-28T21:00:00-03:00" }).outsideHours, true);
  assert.deepEqual(findSlots({ ...query, meal: "dinner", days: ["sat"] }).slots, []);
  const coffee = q({ config: { ...CONFIG, windowStart: "17:00", windowEnd: "19:00" }, meal: "coffee" });
  const first = findSlots(coffee).slots[0]!;
  assert.equal(first.start, "2026-09-28T17:00:00-03:00");
  assert.equal(Date.parse(first.end) - Date.parse(first.start), 30 * 60_000);
  assert.equal(checkTime({ ...coffee, start: "2026-09-28T18:30:00-03:00" }).outsideHours, false);
  assert.equal(checkTime({ ...coffee, start: "2026-09-28T09:00:00-03:00" }).outsideHours, true);
});

for (const meal of ["lunch", "dinner"] as const) {
  test(`the CLI defaults ${meal} to 60 minutes for searches and exact times, with explicit duration taking precedence`, () => {
    const home = tmpHome();
    writeJson(join(home, "config.json"), CONFIG);
    const busyFile = join(home, "busy.json");
    writeJson(busyFile, { busy: [], degraded: [] });
    const args = ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--meal", meal];
    const start = meal === "lunch" ? "2026-09-28T11:30:00-03:00" : "2026-09-28T18:00:00-03:00";
    for (const mode of [[], ["--at", start]]) {
      for (const duration of [undefined, 45]) {
        const result = cli("slots.ts", [...args, ...mode, ...(duration === undefined ? [] : ["--duration", String(duration)])], { MEETLY_HOME: home });
        assert.equal(result.status, 0, result.stderr);
        const slot = mode.length ? result.json.slot : result.json.slots[0];
        assert.equal(slot.start, start);
        assert.equal((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000, duration ?? 60);
      }
    }
    writeJson(busyFile, { busy: [{
      start: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      end: new Date(Date.parse(start) + 60 * 60_000).toISOString(),
    }], degraded: [] });
    const blocked = cli("slots.ts", [...args, "--at", start], { MEETLY_HOME: home });
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
  const first = cli("slots.ts", [...args, "--meal", "dinner"], { MEETLY_HOME: home });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.slots[0].start, "2026-09-28T18:00:00-03:00");
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, {
    origin: "owner", handle: "+15551234567", topic: "dinner", meal: "dinner", durationMin: 45,
    offered: first.json.slots.map((s: object) => ({ ...s, account: CONFIG.defaultAccount })),
  }, NOW, "dinner"));
  const again = cli("slots.ts", ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--request", "dinner", "--after", "19:00"], { MEETLY_HOME: home });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.slots[0].start, "2026-09-28T19:00:00-03:00");
  assert.equal(again.json.slots[0].end, "2026-09-28T19:45:00-03:00");
  const coffee = cli("slots.ts", ["--in", busyFile, "--now", new Date(NOW).toISOString(), "--meal", "coffee", "--after", "17:00"], { MEETLY_HOME: home });
  assert.equal(coffee.status, 0, coffee.stderr);
  assert.equal(coffee.json.slots[0].start, "2026-09-28T17:00:00-03:00");
  assert.equal(coffee.json.slots[0].end, "2026-09-28T17:30:00-03:00");
});
