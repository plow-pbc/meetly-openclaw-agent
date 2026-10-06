import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { addRequest, findByChat, type Request } from "../skills/meetly/scripts/ledger.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { pendingNudges } from "../skills/meetly/scripts/pipeline.ts";
import { checkReminder } from "../skills/meetly/scripts/reminder-check.ts";
import { cli, tmpHome } from "./helpers.ts";

const at = Date.parse("2026-10-05T08:00:00Z");
const base = addRequest({ requests: [] }, {
  origin: "owner", handle: "+15555550101", name: "Guest", topic: "Call", durationMin: 30,
  travel: { beforeMin: 0, afterMin: 0 }, status: "asked", offered: [],
  constraints: { from: "2026-10-05", to: "2026-10-06", days: ["mon"], after: "10:00" }, excludedDays: ["tue"],
}, at, "one").requests[0]!;

function home(t: TestContext, requests = [base]) {
  const dir = tmpHome();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJson(join(dir, "ledger.json"), { requests });
  return dir;
}

test("all-status lookup intersects identity filters and prioritizes bookings in a chat", t => {
  const booked: Request = { ...base, id: "booked", status: "booked", chatUid: "chat" };
  const dropped: Request = { ...base, id: "dropped", status: "dropped", chatUid: "chat" };
  const dir = home(t, [base, booked, dropped]);
  const env = { MEETLY_HOME: dir };
  const result = cli("ledger.ts", ["find", "--scope", "all", "--handle", base.handle], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.requests.map((r: Request) => r.id), ["one", "booked", "dropped"]);
  assert.equal(cli("ledger.ts", ["find", "--scope", "all", "--id", "booked", "--status", "dropped"], env).json.requests.length, 0);
  assert.equal(findByChat({ requests: [booked, dropped] }, "chat")?.id, "booked");
});

test("date widening changes only the selected request dates and preserves unrestricted bounds", t => {
  const other = { ...base, id: "other", handle: "+15555550102", constraints: { days: ["fri"] } };
  const dir = home(t, [base, other]);
  const env = { MEETLY_HOME: dir };
  const result = cli("ledger.ts", ["widen-dates", "--id", "one", "--from", "2026-10-01", "--to", "2026-10-31"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.request.constraints, { ...base.constraints, from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(result.json.request.excludedDays, ["tue"]);
  const next = cli("ledger.ts", ["widen-dates", "--id", "other", "--from", "2026-10-01", "--to", "2026-10-31"], env);
  assert.deepEqual(next.json.request.constraints, other.constraints);
  const before = readFileSync(join(dir, "ledger.json"), "utf8");
  for (const args of [
    ["--from", "2026-02-30", "--to", "2026-03-01"],
    ["--from", "2026-10-31", "--to", "2026-10-01"],
    ["--from", "2026-10-01", "--to", "2026-10-31", "--json", "{}"],
  ]) assert.notEqual(cli("ledger.ts", ["widen-dates", "--id", "one", ...args], env).status, 0);
  assert.equal(readFileSync(join(dir, "ledger.json"), "utf8"), before);
});

for (const command of ["add", "save"]) for (const source of ["flag", "json"]) {
  test(`${command} rejects a model id from ${source} before effects`, t => {
    const dir = home(t, []), before = readFileSync(join(dir, "ledger.json"), "utf8");
    const { id, createdAt, updatedAt, status, ...input } = base;
    const result = cli("ledger.ts", [command, "--json", JSON.stringify({
      ...input, status: "asked", ...(source === "json" ? { id: "model" } : {}),
    }), ...(source === "flag" ? ["--id", "model"] : [])], { MEETLY_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Do not pass id/);
    assert.equal(readFileSync(join(dir, "ledger.json"), "utf8"), before);
  });
}

test("owner-originated asked requests never receive bare offer-time nudges", () => {
  const inbound = { ...base, id: "inbound", origin: "inbound" as const };
  assert.deepEqual(pendingNudges({ requests: [base, { ...base, id: "group", origin: "owner-group" }, inbound] }, at).map(r => r.id), ["inbound"]);
});

test("reminder times include the configured zone", () => {
  const start = "2026-10-05T10:00:00Z", end = "2026-10-05T10:30:00Z";
  const request = { ...base, status: "booked" as const, format: "meet" as const, eventId: "event", booked: { start, end, account: "owner@example.com" } };
  const result = checkReminder(request, {
    id: "event", start, end, status: "confirmed", meetUrl: "https://meet.google.com/abc-defg-hij",
  }, Date.parse(start) - 60_000, { expectedStart: start, leadMin: 10, tz: "America/Los_Angeles" });
  assert.match(result.send!.time, /America\/Los_Angeles/);
});

test("new ledger records cannot create a second meeting in a booked conversation", () => {
  const booked = { ...base, status: "booked" as const, chatUid: "chat" };
  const { id, status, createdAt, updatedAt, ...input } = base;
  assert.throws(() => addRequest({ requests: [booked] }, {
    ...input, status: "asked", origin: "owner-group", chatUid: "chat",
  }, at, "second"), /SEPARATE_MEETING_REQUIRED/);
});
