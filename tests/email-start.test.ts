import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { emailStart } from "../skills/meetly/scripts/email.ts";
import { addRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, cli, fakeCalendar, tmpHome } from "./helpers.ts";

for (const sent of [true, false, "unknown", "transport-unknown"] as const) test(`email start receipt owns linking and failed-hold cleanup: ${sent}`, async t => {
  const home = tmpHome(), previous = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const offered = [{ start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", account: "owner@example.com", holdId: "hold" }];
  const path = join(home, "ledger.json");
  writeJson(path, addRequest({ requests: [] }, { travel: { beforeMin: 0, afterMin: 0 }, channel: "email", origin: "owner", handle: "ana@example.net", topic: "Coffee", durationMin: 30, offered }, Date.now(), "request"));
  const read = () => readJson<Ledger>(path, { requests: [] }).requests[0]!;
  const prepared = cli("email.ts", ["prepare", "--id", "request"], { MEETLY_HOME: home });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.ok(read().startedAt);
  assert.equal(cli("email.ts", ["prepare", "--id", "request"], { MEETLY_HOME: home }).status, 1);
  const calendar = fakeCalendar([calendarEvent("hold", offered[0]!.start, offered[0]!.end)]);
  const receipt = sent === false ? { success: false as const } : sent === "transport-unknown" ? { success: false as const, delivery_unknown: true } : { sent, chat_uid: sent === true ? "thread" : null };
  if (sent === false) await emailStart("request", receipt, { command: calendar.command });
  else {
    const result = cli("email.ts", ["receipt", "--id", "request", "--json", JSON.stringify(receipt)], { MEETLY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(read().chatUid, sent === true ? "thread" : undefined);
  assert.equal(read().status, sent === false ? "dropped" : "offered");
  assert.equal(!!read().startCompletedAt, sent !== false);
  assert.equal(calendar.events.get("hold")!.status, sent === false ? "cancelled" : "confirmed");
  if (sent === true) {
    await assert.rejects(emailStart("request", { sent: true, chat_uid: "unrelated" }), /another chat/);
    await assert.rejects(emailStart("request", { success: false }), /already completed/);
    assert.equal(read().chatUid, "thread");
  }
  t.diagnostic(JSON.stringify({ receipt, request: read(), calendarCalls: calendar.calls.map(call => call[2]) }));
});
