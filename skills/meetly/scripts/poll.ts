// The 5-minute poll as a scheduler command job: no model call unless there is
// something for the model to decide or word. It reads the owner's new
// iMessages through the Mac relay and checks the ledger for due reminders,
// expiries, cleanups, unresolved calendar writes and owner nudges. When any of
// those need the model, it saves them as one batch and wakes one agent turn
// with OpenClaw's system event; that turn reads the batch (`poll.ts batch`),
// moves the cursor itself and clears the batch (`poll.ts done`).
//
// The cursor moves here only when nothing in the batch is for the model: the
// first run, and rows that are all the owner's own or from group chats.
import { rmSync } from "node:fs";
import { isMain, run } from "./cli.ts";
import { pendingCalendarWrites } from "./calendar.ts";
import { holdHours, reminderLeadMin, type Config } from "./config.ts";
import { spawnRunner, type Runner } from "./cron-backend.ts";
import { markFail, markOk, setRowid, type Cursor } from "./cursor.ts";
import { cleanupList, dueReminders, expiredRequests, type Ledger } from "./ledger.ts";
import { runOnMacOutcome, type MacOutcome } from "./mac.ts";
import { file } from "./paths.ts";
import { pendingNudges } from "./pipeline.ts";
import { readJson, updateJson, writeJson } from "./store.ts";

// A row of `plow-messages search`, one JSON object per line.
export type Row = { rowid: number; chat_guid?: string; sender?: string; is_from_me?: boolean; at?: string; body?: string; [key: string]: unknown };
export type Batch = {
  id: string; wokeAt: string; upto?: number; rows: Row[]; reasons: string[];
  readFailure?: "not-connected" | "refused";
};

// A woken turn has the run timeout to finish before the batch is rebuilt.
export const TURN_MS = 10 * 60_000;
const LIMIT = 50;
const BATCH = () => file("poll-batch.json");
const EMPTY_CURSOR: Cursor = { rowid: null };

// Group chats carry `;+;` in their guid; anything else is treated as direct,
// so an unfamiliar guid never hides a message from the model.
export const isInboundDirect = (row: Row) => !row.is_from_me && !row.chat_guid?.includes(";+;");

export function parseRows(output: string): Row[] {
  return output.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Row)
    .sort((a, b) => a.rowid - b.rowid);
}

// Ledger work that needs the model: wording to send, or a calendar writer
// only a turn reports on.
export function ledgerReasons(ledger: Ledger, now: number): string[] {
  return [
    dueReminders(ledger, now, reminderLeadMin()).length ? "reminders" : "",
    expiredRequests(ledger, holdHours(), now).length ? "expired" : "",
    cleanupList(ledger).length ? "cleanup" : "",
    pendingCalendarWrites().length ? "calendar-writes" : "",
    pendingNudges(ledger, now, pendingCalendarWrites()).length ? "nudge" : "",
  ].filter(Boolean);
}

type Mac = (argv: string[]) => Promise<MacOutcome | undefined>;
const messages = (argv: string[]) => runOnMacOutcome({
  argv: ["plow-messages", ...argv], readPaths: ["~/Library/Messages"],
  goal: "Read new inbound messages for Meetly's scheduled poll.",
});

// The wake: a system event on the batch's own session, so a retried batch
// keeps its earlier turn's context and an unrelated conversation never sees it.
export function wake(batch: Batch, runner: Runner = spawnRunner): void {
  const proc = runner(["node", "/app/openclaw.mjs", "system", "event", "--session-key", `agent:main:meetly-poll-${batch.id}`,
    "--mode", "now", "--text", `Meetly poll: batch ${batch.id} is ready (${batch.reasons.join(", ")}).`, "--json"]);
  if (proc.status !== 0) throw new Error(`wake failed (exit ${proc.status}): ${proc.stderr || proc.stdout}`);
}

export async function poll({ now = Date.now(), mac = messages, runner = spawnRunner }: { now?: number; mac?: Mac; runner?: Runner } = {}) {
  const config = readJson<Partial<Config> | null>(file("config.json"), null);
  if (!config?.setupDoneAt || config.paused) return { woke: false, skipped: "not-ready" };
  const pending = readJson<Batch | null>(BATCH(), null);
  if (pending && now - Date.parse(pending.wokeAt) < TURN_MS) return { woke: false, skipped: "turn-running", batch: pending.id };

  const cursorPath = file("cursor.json");
  const cursor = readJson<Cursor>(cursorPath, EMPTY_CURSOR);
  const reasons = ledgerReasons(readJson<Ledger>(file("ledger.json"), { requests: [] }), now);
  let rows: Row[] = [], upto: number | undefined, readFailure: Batch["readFailure"];

  if (cursor.rowid === null) {
    // First run: start from the newest message; never scan history.
    const latest = await mac(["search", "--order", "desc", "--limit", "1"]);
    if (latest && "output" in latest) {
      const rowid = parseRows(latest.output).at(-1)?.rowid ?? 0;
      updateJson<Cursor>(cursorPath, EMPTY_CURSOR, c => setRowid(c, rowid, now));
    }
  } else {
    const found = await mac(["search", "--after-rowid", String(cursor.rowid), "--order", "asc", "--limit", String(LIMIT)]);
    if (!found || !("output" in found)) {
      let warn = false;
      updateJson<Cursor>(cursorPath, EMPTY_CURSOR, c => { const r = markFail(c, now); warn = r.warn; return r.cursor; });
      if (warn) { readFailure = found ? "refused" : "not-connected"; reasons.push("read-failure"); }
    } else {
      updateJson<Cursor>(cursorPath, EMPTY_CURSOR, markOk);
      const batch = parseRows(found.output);
      rows = batch.filter(isInboundDirect);
      upto = batch.at(-1)?.rowid;
      if (rows.length) reasons.push("messages");
      else if (upto !== undefined) updateJson<Cursor>(cursorPath, EMPTY_CURSOR, c => setRowid(c, upto!, now));
    }
  }

  if (!reasons.length) {
    rmSync(BATCH(), { force: true });
    return { woke: false };
  }
  const batch: Batch = { id: String(now), wokeAt: new Date(now).toISOString(), rows, reasons,
    ...(rows.length ? { upto } : {}), ...(readFailure ? { readFailure } : {}) };
  writeJson(BATCH(), batch);
  try {
    wake(batch, runner);
  } catch (error) {
    // The next poll retries at once instead of waiting out a turn that never started.
    rmSync(BATCH(), { force: true });
    throw error;
  }
  return { woke: true, batch: batch.id, reasons, rows: rows.length };
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, id] = process.argv.slice(2);
    if (cmd === undefined) return poll();
    if (cmd === "batch") return { batch: readJson<Batch | null>(BATCH(), null) };
    if (cmd === "done") {
      const pending = readJson<Batch | null>(BATCH(), null);
      if (pending && pending.id !== id) throw new Error(`batch ${id} is not the pending batch (${pending.id})`);
      rmSync(BATCH(), { force: true });
      return { done: id };
    }
    throw new Error("usage: poll.ts | poll.ts batch | poll.ts done <batch id>");
  });
}
