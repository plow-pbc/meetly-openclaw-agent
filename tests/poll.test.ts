import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { poll, TURN_MS, type Batch } from "../skills/meetly/scripts/poll.ts";
import type { Proc } from "../skills/meetly/scripts/cron-backend.ts";
import type { Cursor } from "../skills/meetly/scripts/cursor.ts";
import type { MacOutcome } from "../skills/meetly/scripts/mac.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-05T12:00:00Z");
const row = (rowid: number, over: Record<string, unknown> = {}) =>
  ({ rowid, chat_guid: "iMessage;-;+15550001111", sender: "+15550001111", is_from_me: false, at: "2026-10-05T11:59:00Z", body: "lunch next week?", ...over });

// A Meetly home after setup, a Mac holding `rows`, and a wake that records its argv.
function fixture(rows: Record<string, unknown>[] = [], cursor: Cursor = { rowid: 100 }) {
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  writeJson(join(home, "config.json"), { ownerName: "Patrick", timezone: "America/Los_Angeles", setupDoneAt: "2026-10-01T00:00:00Z" });
  writeJson(join(home, "cursor.json"), cursor);
  const reads: string[][] = [];
  const wakes: string[][] = [];
  let macUp = true;
  const mac = async (argv: string[]): Promise<MacOutcome | undefined> => {
    reads.push(argv);
    if (!macUp) return undefined;
    const after = argv.includes("--after-rowid") ? Number(argv[argv.indexOf("--after-rowid") + 1]) : -1;
    const found = rows.filter(r => (r.rowid as number) > after);
    const out = argv.includes("desc") ? found.slice(-1) : found;
    return { output: out.map(r => JSON.stringify(r)).join("\n") };
  };
  let wakeStatus = 0;
  const runner = (argv: string[]): Proc => { wakes.push(argv); return { status: wakeStatus, stdout: "{}", stderr: wakeStatus ? "gateway down" : "" }; };
  return {
    home, reads, wakes,
    run: (now = T0) => poll({ now, mac, runner }),
    cursor: () => readJson<Cursor>(join(home, "cursor.json"), { rowid: null }),
    batch: () => readJson<Batch | null>(join(home, "poll-batch.json"), null),
    macDown: () => { macUp = false; },
    failWake: () => { wakeStatus = 1; },
    recoverWake: () => { wakeStatus = 0; },
  };
}

test("no new messages and no ledger work: no turn is started and the cursor stays", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { woke: false });
  assert.equal(f.wakes.length, 0);
  assert.equal(f.cursor().rowid, 100);
  assert.equal(f.batch(), null);
});

test("new inbound messages start exactly one turn, with the messages in its batch", async () => {
  const f = fixture([row(101, { addressBookId: "private-contact", attachment: "private-attachment" }), row(102, { sender: "+15550002222", chat_guid: "iMessage;-;+15550002222" }), row(103, { is_from_me: true })]);
  const result = await f.run();
  assert.equal(result.woke, true);
  assert.equal(f.wakes.length, 1);
  const wake = f.wakes[0]!;
  assert.deepEqual(wake.slice(0, 4), ["node", "/app/openclaw.mjs", "system", "event"]);
  assert.equal(wake[wake.indexOf("--mode") + 1], "now");
  const batch = f.batch()!;
  assert.equal(wake[wake.indexOf("--session-key") + 1], `agent:main:meetly-poll-${batch.id}`);
  assert.match(wake[wake.indexOf("--text") + 1]!, new RegExp(`^Meetly poll: batch ${batch.id} is ready`));
  assert.deepEqual(batch.rows.map(r => r.rowid), [101, 102]);
  assert.deepEqual(Object.keys(batch.rows[0]!).sort(), ["at", "body", "rowid", "sender"]);
  assert.equal(batch.upto, 103);
  assert.deepEqual(batch.reasons, ["messages"]);
});

test("the cursor moves only after the woken turn handles the batch", async () => {
  const f = fixture([row(101)]);
  await f.run();
  assert.equal(f.cursor().rowid, 100, "the job leaves the batch's rows unread");
  // While the turn runs, later polls neither wake it again nor rebuild its batch.
  const id = f.batch()!.id;
  assert.deepEqual(await f.run(T0 + 5 * 60_000), { woke: false, skipped: "turn-running", batch: id });
  assert.equal(f.wakes.length, 1);
  // The turn sets the cursor and clears its batch, as the skill says.
  const env = { MEETLY_HOME: f.home };
  assert.equal(cli("cursor.ts", ["set", "101"], env).status, 0);
  assert.equal(cli("poll.ts", ["done", id], env).status, 0);
  assert.equal(f.batch(), null);
  assert.deepEqual(await f.run(T0 + 10 * 60_000), { woke: false });
  assert.equal(f.cursor().rowid, 101);
});

test("an unfinished turn re-wakes the same batch without rereading messages", async () => {
  const f = fixture([row(101)]);
  await f.run();
  const first = f.batch()!.id;
  const again = await f.run(T0 + TURN_MS);
  assert.equal(again.woke, true);
  assert.equal(f.wakes.length, 2);
  assert.equal(f.batch()!.id, first);
  assert.equal(f.reads.length, 1);
  assert.equal(f.wakes[1]![f.wakes[1]!.indexOf("--session-key") + 1], `agent:main:meetly-poll-${first}`);
  assert.deepEqual(f.batch()!.rows.map(r => r.rowid), [101]);
  assert.equal(f.cursor().rowid, 100);
});

for (const failedWake of [false, true]) test(`an unreadable-Mac warning survives until done: failedWake=${failedWake}`, async () => {
  const f = fixture([], { rowid: 100, failingSince: new Date(T0 - 31 * 60_000).toISOString() });
  f.macDown();
  if (failedWake) f.failWake();
  if (failedWake) await assert.rejects(f.run(), /wake failed/);
  else await f.run();
  const first = f.batch()!;
  assert.equal(first.readFailure, "not-connected");
  assert.ok(f.cursor().warnedAt);
  f.recoverWake();
  await f.run(T0 + TURN_MS);
  assert.deepEqual(f.batch(), { ...first, wokeAt: new Date(T0 + TURN_MS).toISOString() });
  assert.equal(f.reads.length, 1, "retries preserve the one-shot warning instead of rebuilding it");
  assert.equal(f.wakes.length, 2);
  const env = { MEETLY_HOME: f.home };
  assert.notEqual(cli("poll.ts", ["done", "old-batch"], env).status, 0);
  assert.ok(f.batch());
  assert.equal(cli("poll.ts", ["done", first.id], env).status, 0);
  assert.equal(f.batch(), null);
  assert.deepEqual(await f.run(T0 + 2 * TURN_MS), { woke: false });
});

test("rows that are all the owner's own or from groups move the cursor without a turn", async () => {
  const f = fixture([row(101, { is_from_me: true }), row(102, { chat_guid: "iMessage;+;chat123" })]);
  assert.deepEqual(await f.run(), { woke: false });
  assert.equal(f.wakes.length, 0);
  assert.equal(f.cursor().rowid, 102);
});

test("the first run starts at the newest message without a turn", async () => {
  const f = fixture([row(101), row(102)], { rowid: null });
  assert.deepEqual(await f.run(), { woke: false });
  assert.deepEqual(f.reads[0], ["search", "--order", "desc", "--limit", "1"]);
  assert.equal(f.cursor().rowid, 102);
  assert.equal(f.wakes.length, 0);
});

test("due reminders and expired requests still wake a turn with no new messages", async () => {
  const f = fixture();
  const start = new Date(T0 + 5 * 60_000).toISOString();
  writeJson(join(f.home, "ledger.json"), { requests: [
    { id: "r_meet", status: "booked", format: "meet", meetUrl: "https://meet.google.com/abc-defg-hij", handle: "+1", topic: "sync",
      booked: { start, end: start, account: "a" }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", lastNudge: { fingerprint: "x", at: "x" } },
    { id: "r_old", status: "asked", handle: "+2", topic: "lunch", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
      lastNudge: { fingerprint: "owner-decision:2026-10-01T00:00:00Z", at: "2026-10-01T00:00:00Z" } },
  ] });
  const result = await f.run();
  assert.equal(result.woke, true);
  assert.ok(f.batch()!.reasons.includes("reminders"));
  assert.ok(f.batch()!.reasons.includes("expired"));
  assert.deepEqual(f.batch()!.rows, []);
  assert.equal(f.batch()!.upto, undefined, "no rows: the turn has no cursor to move");
});

test("an unreadable Mac wakes the turn only once the 30-minute warning is due", async () => {
  const f = fixture([row(101)]);
  f.macDown();
  assert.deepEqual(await f.run(), { woke: false });
  const warned = await f.run(T0 + 31 * 60_000);
  assert.equal(warned.woke, true);
  assert.equal(f.batch()!.readFailure, "not-connected");
  assert.equal(f.cursor().rowid, 100);
});

test("before setup or while paused the job does nothing", async () => {
  const f = fixture([row(101)]);
  writeJson(join(f.home, "config.json"), { ownerName: "Patrick", setupDoneAt: "2026-10-01T00:00:00Z", paused: true });
  assert.deepEqual(await f.run(), { woke: false, skipped: "not-ready" });
  writeJson(join(f.home, "config.json"), { ownerName: "Patrick" });
  assert.deepEqual(await f.run(), { woke: false, skipped: "not-ready" });
  assert.equal(f.reads.length + f.wakes.length, 0);
});

test("done refuses a batch that is not the pending one", async () => {
  const f = fixture([row(101)]);
  await f.run();
  const res = cli("poll.ts", ["done", "123"], { MEETLY_HOME: f.home });
  assert.notEqual(res.status, 0);
  assert.ok(f.batch());
});
