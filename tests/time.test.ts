import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { tmpHome } from "./helpers.ts";
import { addDays, DAYS, resolveWeekday, WeekdayDateRequired, localIso, offsetMs, wallParts, zonedToUtc } from "../skills/meetly/scripts/time.ts";

test("DAYS is in week order starting Monday", () => {
  assert.deepEqual(DAYS, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});

test("Sao Paulo wall time converts to UTC and back", () => {
  const ms = zonedToUtc(2026, 9, 28, 10, 0, "America/Sao_Paulo");
  assert.equal(new Date(ms).toISOString(), "2026-09-28T13:00:00.000Z");
  assert.equal(localIso(ms, "America/Sao_Paulo"), "2026-09-28T10:00:00-03:00");
  assert.equal(offsetMs(ms, "America/Sao_Paulo"), -3 * 3600_000);
});

test("Los Angeles across the end of daylight saving", () => {
  const pdt = zonedToUtc(2026, 10, 31, 9, 0, "America/Los_Angeles");
  const pst = zonedToUtc(2026, 11, 1, 9, 0, "America/Los_Angeles");
  assert.equal(new Date(pdt).toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(new Date(pst).toISOString(), "2026-11-01T17:00:00.000Z");
  assert.equal(localIso(pst, "America/Los_Angeles"), "2026-11-01T09:00:00-08:00");
});

test("wallParts gives the local weekday and fields", () => {
  const p = wallParts(Date.parse("2026-09-28T13:05:07Z"), "America/Sao_Paulo");
  assert.deepEqual(p, { y: 2026, m: 9, d: 28, hh: 10, mm: 5, ss: 7, weekday: "mon" });
  assert.equal(wallParts(Date.parse("2026-09-28T02:00:00Z"), "America/Sao_Paulo").weekday, "sun");
});

test("localIso handles UTC and positive offsets", () => {
  assert.equal(localIso(Date.parse("2026-09-28T00:00:00Z"), "UTC"), "2026-09-28T00:00:00+00:00");
  assert.equal(localIso(Date.parse("2026-09-28T00:00:00Z"), "Asia/Kolkata"), "2026-09-28T05:30:00+05:30");
});

test("addDays crosses month and year ends", () => {
  assert.deepEqual(addDays(2026, 9, 29, 3), { y: 2026, m: 10, d: 2 });
  assert.deepEqual(addDays(2026, 12, 31, 1), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(addDays(2026, 3, 1, -1), { y: 2026, m: 2, d: 28 });
});

test("next_week CLI resolves the anchor's local calendar week across timezone and DST boundaries", async () => {
  const { cli } = await import("./helpers.ts");
  for (const [anchor, timezone, from, to] of [
    ["2026-10-05T00:30:00Z", "America/Los_Angeles", "2026-10-05", "2026-10-11"],
    ["2026-10-05T00:30:00Z", "UTC", "2026-10-12", "2026-10-18"],
    ["2026-10-23T12:00:00-07:00", "America/Los_Angeles", "2026-10-26", "2026-11-01"],
    ["2026-10-27T12:00:00-07:00", "America/Los_Angeles", "2026-11-02", "2026-11-08"],
    ["2026-12-31T12:00:00Z", "UTC", "2027-01-04", "2027-01-10"],
  ]) {
    const home = tmpHome();
    writeJson(join(home, "config.json"), { timezone, setupDoneAt: "2026-10-01T00:00:00Z", calendars: [] });
    const result = cli("time.ts", ["next_week", "--anchor", anchor!], { MEETLY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { from, to });
  }
});

test("next_week requires an unambiguous source timestamp", async () => {
  const { cli } = await import("./helpers.ts");
  for (const anchor of ["2026-10-05", "2026-10-05T12:00:00", "not a timestamp"]) {
    const home = tmpHome();
    writeJson(join(home, "config.json"), { timezone: "UTC", setupDoneAt: "2026-10-01T00:00:00Z", calendars: [] });
    const result = cli("time.ts", ["next_week", "--anchor", anchor], { MEETLY_HOME: home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /anchor timestamp with a timezone offset/);
  }
});

test("bare weekdays resolve in the offer's local calendar weeks across timezone, DST and year boundaries", () => {
  for (const [offered, timezone, weekday, expected] of [
    [["2026-10-15T11:30:00-07:00", "2026-10-12T11:30:00-07:00"], "America/Los_Angeles", "tue", "2026-10-13T16:00:00-07:00"],
    [["2026-10-15T11:30:00-07:00"], "America/Los_Angeles", "tue", "2026-10-13T16:00:00-07:00"],
    [["2026-10-12T00:30:00Z"], "America/Los_Angeles", "tue", "2026-10-06T16:00:00-07:00"],
    [["2026-10-30T11:30:00-07:00"], "America/Los_Angeles", "sun", "2026-11-01T16:00:00-08:00"],
    [["2026-12-31T11:30:00Z", "2027-01-01T11:30:00Z"], "UTC", "fri", "2027-01-01T16:00:00+00:00"],
  ] as const) {
    assert.equal(resolveWeekday({ weekday, time: "16:00" }, offered.map(start => ({ start })), timezone), expected);
  }
});

test("weekday resolution requires one date in the bounded offer window and a real clock time", () => {
  const offered = [{ start: "2026-10-12T11:30:00Z" }, { start: "2026-10-19T11:30:00Z" }];
  const requested = { weekday: "tue", time: "16:00" } as const;
  assert.throws(() => resolveWeekday(requested, [], "UTC"), WeekdayDateRequired);
  assert.throws(() => resolveWeekday(requested, offered, "UTC"), WeekdayDateRequired);
  assert.throws(() => resolveWeekday(requested, offered, "UTC", { from: "2026-10-14", to: "2026-10-18" }), WeekdayDateRequired);
  assert.equal(resolveWeekday(requested, offered, "UTC", { from: "2026-10-14", to: "2026-10-25" }), "2026-10-20T16:00:00+00:00");
  assert.throws(() => resolveWeekday({ weekday: "tue", time: "25:00" }, offered, "UTC"), /Invalid weekday or clock time/);
  assert.throws(() => resolveWeekday({ weekday: "sun", time: "02:30" }, [{ start: "2026-03-06T11:30:00-08:00" }], "America/Los_Angeles"), /does not exist/);
});

test("next_week rejects model timezone overrides and missing owner timezone", async () => {
  const { cli } = await import("./helpers.ts");
  const home = tmpHome();
  writeJson(join(home, "config.json"), { timezone: "America/Los_Angeles", setupDoneAt: "2026-10-01T00:00:00Z", calendars: [] });
  const override = cli("time.ts", ["next_week", "--anchor", "2026-10-05T00:03:49Z", "--timezone", "UTC"], { MEETLY_HOME: home });
  assert.equal(override.status, 1);
  assert.match(override.stderr, /timezone/);
  writeJson(join(home, "config.json"), { setupDoneAt: "2026-10-01T00:00:00Z", calendars: [] });
  const missing = cli("time.ts", ["next_week", "--anchor", "2026-10-05T00:03:49Z"], { MEETLY_HOME: home });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /timezone/);
});
