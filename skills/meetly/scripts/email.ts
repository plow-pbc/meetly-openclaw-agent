import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { calendarAction, pendingCalendarWrites, type CalendarOptions } from "./calendar.ts";
import { isMain, run } from "./cli.ts";
import { recordDelivery, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

type Receipt = { sent?: true | "unknown"; success?: false; delivery_unknown?: boolean; chat_uid?: string | null };
export async function emailStart(id: string, receipt?: Receipt, options: CalendarOptions = {}) {
  const path = file("ledger.json"), now = (options.now ?? Date.now)();
  const request = readJson<Ledger>(path, { requests: [] }).requests.find(r => r.id === id);
  if (request?.channel !== "email") throw new Error("Choose an email request.");
  if (receipt === undefined) {
    // An unresolved offer may still be dropped; its times must not reach the guest.
    if (pendingCalendarWrites().includes(id)) throw new Error("The offer's calendar holds are unresolved; do not email these times. Tell the owner the offer could not be confirmed.");
    updateJson<Ledger>(path, { requests: [] }, l => recordDelivery(l, id, "start", "begin", now));
    return { prepared: true, requestId: id };
  }
  if ((receipt.sent !== true && receipt.sent !== "unknown" && receipt.success !== false) || (receipt.chat_uid != null && (typeof receipt.chat_uid !== "string" || !receipt.chat_uid.trim()))) throw new Error("Pass the email tool's send receipt unchanged.");
  if (!request.startedAt) throw new Error("No email start attempt to complete.");
  if (receipt.success === false && receipt.delivery_unknown !== true) {
    return calendarAction(id, { action: "drop" }, { ...options, validate(current) {
      options.validate?.(current);
      if (current.chatUid || current.startCompletedAt) throw new Error("Email start was already completed; do not drop it from a conflicting receipt.");
    } });
  }
  const ledger = updateJson<Ledger>(path, { requests: [] }, l => {
    const next = recordDelivery(l, id, "start", "complete", now);
    return receipt.chat_uid ? updateRequest(next, id, { chatUid: receipt.chat_uid }, now) : next;
  });
  return { request: ledger.requests.find(r => r.id === id), uncertain: receipt.delivery_unknown === true || receipt.sent === "unknown" || !receipt.chat_uid };
}

if (isMain(import.meta.url)) run(() => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: "string" }, json: { type: "string" }, "json-file": { type: "string" } } });
  if (!values.id || !["prepare", "receipt"].includes(positionals[0] ?? "")) throw new Error("usage: email.ts prepare|receipt --id X [--json '<send receipt>' | --json-file F]");
  const raw = values["json-file"] ? readFileSync(values["json-file"], "utf8") : values.json;
  if (positionals[0] === "receipt" && !raw) throw new Error("receipt needs the email tool's JSON result");
  return emailStart(values.id, positionals[0] === "receipt" ? JSON.parse(raw!) : undefined);
});
