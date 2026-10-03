// Derive the owner's pipeline from request state. Reserving a batch and its
// fingerprints in one ledger write makes an uncertain send non-repeatable.
import { parseArgs } from "node:util";
import { pendingCalendarWrites } from "./calendar.ts";
import { isMain, run } from "./cli.ts";
import { nudgeFingerprint, appendLog, doNotContact, setDoNotContact, type Ledger, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export const STALE_OFFER_MS = 24 * 3_600_000;
const EMPTY: Ledger = { requests: [] };
type State = "waiting_on_owner" | "waiting_on_them" | "waiting_on_us";
type Reason = "owner-decision" | "owner-question" | "time-approval" | "answer-delivery" | "offer" | "stale-offer" | "calendar-write";
export type PipelineItem = {
  id: string; name: string; topic: string; status: Request["status"]; state: State; reason: Reason; since: string;
  detail: string; fingerprint: string; nudge: boolean; doNotContact: boolean; log: Request["log"];
};
const line = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 500);

export function pipeline(ledger: Ledger, now: number, unresolved: readonly string[] = []): PipelineItem[] {
  return ledger.requests.flatMap(request => {
    const blocked = doNotContact(ledger, request.handle);
    let state: State, reason: Reason, since: string, detail: string, nudge = true;
    if (unresolved.includes(request.id)) {
      state = "waiting_on_us"; reason = "calendar-write"; since = request.updatedAt;
      detail = "Calendar write unresolved; reconciliation owns this alert."; nudge = false;
    } else if (request.pendingOwner && ["offered", "booked"].includes(request.status)) {
      const pending = request.pendingOwner;
      since = pending.askedAt;
      if (pending.answerAttemptedAt) {
        state = "waiting_on_us"; reason = "answer-delivery"; since = pending.answerAttemptedAt;
        detail = "Owner answer delivery needs checking; do not resend automatically.";
      } else {
        state = "waiting_on_owner";
        reason = "question" in pending ? "owner-question" : "time-approval";
        detail = "question" in pending ? `Waiting for your answer: ${JSON.stringify(line(pending.question))}.`
          : `Waiting for your approval of ${pending.start}.`;
      }
    } else if (request.status === "asked" && !blocked) {
      state = "waiting_on_owner"; reason = "owner-decision"; since = request.createdAt;
      detail = "Want me to offer times?";
    } else {
      const offeredAt = request.status === "offered" ? request.offeredAt : request.status === "booked" ? request.reoffer?.offeredAt : undefined;
      if (!offeredAt) return [];
      since = offeredAt; state = "waiting_on_them";
      const replied = request.lastGuestReplyAt !== undefined && Date.parse(request.lastGuestReplyAt) >= Date.parse(offeredAt);
      const stale = !replied && now - Date.parse(offeredAt) >= STALE_OFFER_MS;
      reason = stale ? "stale-offer" : "offer"; nudge = stale;
      detail = stale ? "No guest reply to the offer after 24 hours."
        : replied ? "Guest replied; waiting for a time choice." : "Waiting for a reply to the offered times.";
    }
    return [{ id: request.id, name: line(request.name ?? request.handle), topic: line(request.topic), status: request.status,
      state, reason, since, detail, fingerprint: nudgeFingerprint(reason, since), nudge, doNotContact: blocked, log: request.log }];
  });
}

export function renderPipeline(items: PipelineItem[], nudge = false): string | null {
  if (!items.length) return nudge ? null : "Nothing pending.";
  return `${nudge ? "Meetly needs your attention:" : "Meetly pipeline:"}\n${items.map(item =>
    `- ${item.name} — ${item.topic}: ${item.detail} Since ${item.since}.${item.doNotContact ? " Marked do not contact." : ""}`).join("\n")}`;
}

export function reserveNudges(ledger: Ledger, now: number, unresolved: readonly string[] = []) {
  const items = pipeline(ledger, now, unresolved).filter(item => item.nudge
    && ledger.requests.find(r => r.id === item.id)!.lastNudge?.fingerprint !== item.fingerprint);
  const byId = new Map(items.map(item => [item.id, item]));
  return {
    ledger: { requests: ledger.requests.map(request => {
      const item = byId.get(request.id);
      return item ? appendLog({ ...request, lastNudge: { fingerprint: item.fingerprint, at: new Date(now).toISOString() } }, "Owner nudge reserved", now) : request;
    }) },
    items, text: renderPipeline(items, true),
  };
}

if (isMain(import.meta.url)) run(() => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    handle: { type: "string" }, blocked: { type: "string" }, name: { type: "string" },
  } });
  const path = file("ledger.json"), now = Date.now();
  if (positionals[0] === "view") {
    const items = pipeline(readJson<Ledger>(path, EMPTY), now, pendingCalendarWrites());
    return { items, text: renderPipeline(items) };
  }
  if (positionals[0] === "nudge") {
    let batch: ReturnType<typeof reserveNudges>;
    updateJson<Ledger>(path, EMPTY, ledger => {
      batch = reserveNudges(ledger, now, pendingCalendarWrites());
      return batch.ledger;
    });
    return { items: batch!.items, text: batch!.text };
  }
  if (positionals[0] === "contact" && values.handle) {
    if (values.blocked !== undefined && !["true", "false"].includes(values.blocked)) throw new Error("--blocked must be true or false");
    const ledger = values.blocked === undefined ? readJson<Ledger>(path, EMPTY)
      : updateJson<Ledger>(path, EMPTY, l => setDoNotContact(l, values.handle!, values.blocked === "true", now, values.name));
    return { doNotContact: doNotContact(ledger, values.handle) };
  }
  throw new Error("usage: pipeline.ts view | nudge | contact --handle H [--blocked true|false] [--name NAME]");
});
