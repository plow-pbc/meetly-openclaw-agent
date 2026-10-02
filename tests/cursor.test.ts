import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, markFail, markOk, release, setRowid, WARN_AFTER_MS, type Cursor } from "../skills/meetly/scripts/cursor.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T12:00:00Z");

test("setRowid moves forward only and clears failures", () => {
  const c = setRowid({ rowid: null, failingSince: "x", warnedAt: "y" }, 10, T0);
  assert.deepEqual(c, { rowid: 10, updatedAt: new Date(T0).toISOString() });
  assert.throws(() => setRowid(c, 5, T0), /cursor never moves back/);
  assert.equal(setRowid(c, 10, T0).rowid, 10);
  assert.throws(() => setRowid(c, -1, T0));
  assert.throws(() => setRowid(c, 1.5, T0));
});

test("markFail warns exactly once after 30 minutes", () => {
  let c: Cursor = { rowid: 3 };
  let r = markFail(c, T0);
  assert.equal(r.warn, false);
  assert.equal(r.cursor.failingSince, new Date(T0).toISOString());
  r = markFail(r.cursor, T0 + 10 * 60_000);
  assert.equal(r.warn, false);
  assert.equal(r.cursor.failingSince, new Date(T0).toISOString());
  r = markFail(r.cursor, T0 + WARN_AFTER_MS + 60_000);
  assert.equal(r.warn, true);
  assert.ok(r.cursor.warnedAt);
  r = markFail(r.cursor, T0 + 2 * WARN_AFTER_MS);
  assert.equal(r.warn, false);
  c = markOk(r.cursor);
  assert.deepEqual(c, { rowid: 3 });
});

test("CLI get, set, fail and ok", () => {
  const env = { MEETLY_HOME: tmpHome() };
  assert.deepEqual(cli("cursor.ts", ["get"], env).json, { rowid: null });
  assert.equal(cli("cursor.ts", ["set", "10"], env).json.rowid, 10);
  assert.equal(cli("cursor.ts", ["get"], env).json.rowid, 10);
  const back = cli("cursor.ts", ["set", "5"], env);
  assert.equal(back.status, 1);
  assert.match(back.stderr, /cursor never moves back/);
  const fail = cli("cursor.ts", ["fail"], env).json;
  assert.equal(fail.warn, false);
  assert.ok(fail.failingSince);
  assert.ok(cli("cursor.ts", ["get"], env).json.failingSince);
  assert.deepEqual(Object.keys(cli("cursor.ts", ["ok"], env).json).sort(), ["rowid", "updatedAt"]);
  cli("cursor.ts", ["fail"], env);
  assert.equal(cli("cursor.ts", ["set", "11"], env).json.failingSince, undefined);
  assert.equal(cli("cursor.ts", ["set", "x"], env).status, 1);
  assert.equal(cli("cursor.ts", ["jump"], env).status, 1);
});

test("a corrupt cursor.json fails and is left alone", () => {
  const home = tmpHome();
  const path = join(home, "cursor.json");
  writeFileSync(path, "{broken");
  for (const args of [["get"], ["set", "1"], ["fail"]]) {
    const r = cli("cursor.ts", args, { MEETLY_HOME: home });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("a held request row stops the cursor just below it until the ledger records that request", () => {
  const held = hold({ rowid: 1828 }, 1829);
  assert.equal(held.held, 1829);
  const none = () => false;
  const clamped = setRowid(held, 1831, T0, none);
  assert.equal(clamped.rowid, 1828);
  assert.equal(clamped.held, 1829);
  const recorded = setRowid(held, 1831, T0, (rowid) => rowid === 1829);
  assert.equal(recorded.rowid, 1831);
  assert.equal(recorded.held, undefined);
  assert.equal(setRowid(held, 1828, T0, none).rowid, 1828);
});

test("hold only lands ahead of the cursor, keeps the earliest row, and release clears it", () => {
  assert.throws(() => hold({ rowid: 1830 }, 1829), /already past/);
  assert.equal(hold(hold({ rowid: 1828 }, 1831), 1829).held, 1829);
  assert.equal(hold(hold({ rowid: 1828 }, 1829), 1831).held, 1829);
  assert.deepEqual(release({ rowid: 1828, held: 1829 }), { rowid: 1828 });
});

test("CLI hold, then set is clamped until the request is in the ledger", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  cli("cursor.ts", ["set", "1828"], env);
  assert.equal(cli("cursor.ts", ["hold", "1829"], env).json.held, 1829);
  const r = cli("cursor.ts", ["set", "1831"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.rowid, r.json.held], [1828, 1829]);
  writeJson(join(home, "ledger.json"), { requests: [{ id: "r_1", sourceRowid: 1829 }] });
  assert.deepEqual([cli("cursor.ts", ["set", "1831"], env).json.rowid, cli("cursor.ts", ["get"], env).json.held], [1831, undefined]);
  cli("cursor.ts", ["hold", "1840"], env);
  assert.equal(cli("cursor.ts", ["release"], env).json.held, undefined);
});

test("a request saved as asked releases its held row", () => {
  const env = { MEETLY_HOME: tmpHome() };
  cli("cursor.ts", ["set", "1828"], env);
  cli("cursor.ts", ["hold", "1829"], env);
  const asked = { status: "asked", origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, sourceRowid: 1829 };
  assert.equal(cli("ledger.ts", ["save", "--json", JSON.stringify(asked)], env).status, 0);
  const r = cli("cursor.ts", ["set", "1831"], env).json;
  assert.deepEqual([r.rowid, r.held], [1831, undefined]);
});
