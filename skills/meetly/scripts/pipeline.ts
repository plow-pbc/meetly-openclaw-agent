// Derive the owner's pipeline from request state. Reserving a batch and its
// fingerprints in one ledger write makes an uncertain send non-repeatable.
// A confirmed delivery failure releases only that batch for a later retry.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pendingCalendarWrites } from "./calendar.ts";
import { loadConfig } from "./config.ts";
import { localeFormatter } from "./slots.ts";
import { isMain, run } from "./cli.ts";
import { nudgeFingerprint, doNotContact, type Ledger, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export const STALE_OFFER_MS = 24 * 3_600_000;
const EMPTY: Ledger = { requests: [] };
type State = "waiting_on_owner" | "waiting_on_them" | "waiting_on_us";
type Reason = "owner-decision" | "owner-question" | "time-approval" | "answer-delivery" | "offer" | "stale-offer" | "calendar-write";
export type PipelineItem = {
  id: string; name: string; topic: string; status: Request["status"]; state: State; reason: Reason; since: string;
  detail: string; sinceLabel: string; fingerprint: string; nudge: boolean; doNotContact: boolean;
};
type Display = { timezone: string; locale?: string };
type Reservation = { id: string; fingerprint: string; at: string };
const line = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 500);

export function pipeline(ledger: Ledger, now: number, unresolved: readonly string[] = [], display: Display = { timezone: "UTC" }): PipelineItem[] {
  const formatter = localeFormatter(display.locale ?? "en-US", display.timezone);
  const time = (at: string) => `${formatter.format(new Date(at))} (${display.timezone})`;
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
          : `Waiting for your approval of ${time(pending.start)}.`;
      }
    } else if (request.status === "asked" && !blocked) {
      state = "waiting_on_owner"; reason = "owner-decision"; since = request.createdAt;
      detail = "Want me to offer times?";
    } else {
      const offeredAt = ["offered", "booked"].includes(request.status) && request.offered.length ? request.offeredAt : undefined;
      if (!offeredAt) return [];
      since = offeredAt; state = "waiting_on_them";
      const replied = request.lastGuestReplyAt !== undefined && Date.parse(request.lastGuestReplyAt) >= Date.parse(offeredAt);
      const stale = !replied && now - Date.parse(offeredAt) >= STALE_OFFER_MS;
      reason = stale ? "stale-offer" : "offer"; nudge = stale;
      detail = stale ? "No guest reply to the offer after 24 hours."
        : replied ? "Guest replied; waiting for a time choice." : "Waiting for a reply to the offered times.";
    }
    return [{ id: request.id, name: line(request.name ?? request.handle), topic: line(request.topic), status: request.status,
      state, reason, since, sinceLabel: time(since), detail, fingerprint: nudgeFingerprint(reason, since), nudge, doNotContact: blocked }];
  });
}

export function renderPipeline(items: PipelineItem[], nudge = false): string | null {
  if (!items.length) return nudge ? null : "Nothing pending.";
  return `${nudge ? "Meetly needs your attention:" : "Meetly pipeline:"}\n${items.map(item =>
    `- ${item.name} — ${item.topic}: ${item.detail} Since ${item.sinceLabel}.${item.doNotContact ? " Marked do not contact." : ""}`).join("\n")}`;
}

export function reserveNudges(ledger: Ledger, now: number, unresolved: readonly string[] = [], display: Display = { timezone: "UTC" }) {
  const items = pipeline(ledger, now, unresolved, display).filter(item => item.nudge
    && ledger.requests.find(r => r.id === item.id)!.lastNudge?.fingerprint !== item.fingerprint);
  const byId = new Map(items.map(item => [item.id, item]));
  return {
    ledger: { requests: ledger.requests.map(request => {
      const item = byId.get(request.id);
      return item ? { ...request, lastNudge: { fingerprint: item.fingerprint, at: new Date(now).toISOString() } } : request;
    }) },
    items, text: renderPipeline(items, true),
    reservations: items.map(item => ({ id: item.id, fingerprint: item.fingerprint, at: new Date(now).toISOString() })),
  };
}

export function retryFailedNudges(ledger: Ledger, reservations: Reservation[], now: number) {
  if (!Array.isArray(reservations) || reservations.some(r => !r || typeof r.id !== "string" || !r.id
    || typeof r.fingerprint !== "string" || !r.fingerprint || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at)))) {
    throw new Error("retry-failed needs the exact reservations array from the failed nudge batch");
  }
  const released: string[] = [];
  return { ledger: { requests: ledger.requests.map(request => {
    if (!reservations.some(r => r.id === request.id && r.fingerprint === request.lastNudge?.fingerprint && r.at === request.lastNudge?.at)) return request;
    const { lastNudge, ...rest } = request;
    released.push(request.id);
    return rest;
  }) }, released };
}

if (isMain(import.meta.url)) run(() => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    handle: { type: "string" }, locale: { type: "string" },
    json: { type: "string" }, "json-file": { type: "string" },
  } });
  const path = file("ledger.json"), now = Date.now();
  if (positionals[0] === "view") {
    const items = pipeline(readJson<Ledger>(path, EMPTY), now, pendingCalendarWrites(), { timezone: loadConfig().timezone, locale: values.locale });
    return { items, text: renderPipeline(items) };
  }
  if (positionals[0] === "nudge") {
    const display = { timezone: loadConfig().timezone, locale: values.locale };
    let batch: ReturnType<typeof reserveNudges>;
    updateJson<Ledger>(path, EMPTY, ledger => {
      batch = reserveNudges(ledger, now, pendingCalendarWrites(), display);
      return batch.ledger;
    });
    return { items: batch!.items, text: batch!.text, reservations: batch!.reservations };
  }
  if (positionals[0] === "retry-failed") {
    const raw = values["json-file"] ? readFileSync(values["json-file"], "utf8") : values.json;
    if (!raw) throw new Error("retry-failed needs --json or --json-file with the failed batch's reservations");
    const reservations = JSON.parse(raw);
    let released: string[] = [];
    updateJson<Ledger>(path, EMPTY, ledger => {
      const result = retryFailedNudges(ledger, reservations, now);
      released = result.released;
      return result.ledger;
    });
    return { released };
  }
  if (positionals[0] === "contact" && values.handle) {
    return { doNotContact: doNotContact(readJson<Ledger>(path, EMPTY), values.handle) };
  }
  throw new Error("usage: pipeline.ts view|nudge [--locale TAG] | retry-failed --json <reservations> | contact --handle H");
});
