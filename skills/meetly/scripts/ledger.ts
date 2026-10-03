// Meetly's record of every scheduling request: who, which group, which times
// were offered and held, and how it ended. Cleanup records event ids or exact
// operation markers for creates whose event ids were never received.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { holdHours, reminderLeadMin } from "./config.ts";
import { isMeetUrl } from "./event.ts";
import { file } from "./paths.ts";
import type { Constraints } from "./slots.ts";
export type { Constraints } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";

// `asked`: a request seen in the owner's messages, waiting for the owner's
// yes before anyone is contacted. It has no offered times, holds or chat.
export type Status = "asked" | "offered" | "booked" | "dropped" | "expired";
export type Offer = { start: string; end: string; holdId?: string; account: string };
export type HoldRef = { holdId: string; account: string };
export type HoldCleanup = ((HoldRef & { token?: never }) | { token: string; account: string; start: string; end: string; holdId?: never }) & { sendUpdates?: "all" | "none" };
export const sameCleanup = (a: HoldCleanup, b: HoldCleanup) => a.account === b.account && a.holdId === b.holdId && a.token === b.token;
// Notify invitees even if a silent hold cleanup already names the same event.
export const uniqueCleanup = (refs: HoldCleanup[]) =>
  [...refs.filter(ref => ref.sendUpdates === "all"), ...refs.filter(ref => ref.sendUpdates !== "all")]
    .filter((ref, i, all) => all.findIndex(other => sameCleanup(ref, other)) === i);
export const requestId = () => `r_${randomBytes(4).toString("hex")}`;
// A time outside the owner's days or window that the other person asked for,
// waiting for the owner's yes or no.
export type PendingOwner = { start: string; end: string; askedAt: string };
// How the meeting happens. `unknown` until the request or an answer says it.
export type Format = "meet" | "in_person" | "phone" | "unknown";
// The booked event's time, and the Google account it lives on.
export type Booked = { start: string; end: string; account: string };
// The join-time reminder was handled: sent, or not sent for good.
export type Reminder = { at: string; outcome: "sent" | "cancelled" | "no-link" };

export type Request = {
  id: string;
  origin: "inbound" | "owner";
  handle: string;
  name?: string;
  sourceRowid?: number;
  chatUid?: string;
  calendarRevision?: string;
  topic: string;
  location?: string;
  durationMin: number;
  // The owner's conditions, kept for every offer of this request.
  constraints?: Constraints;
  // Times the person proposed; only the first offer uses them.
  proposed?: Constraints;
  allowOverlap?: string[];
  offered: Offer[];
  status: Status;
  eventId?: string;
  holdCleanup?: HoldCleanup[];
  pendingOwner?: PendingOwner;
  format?: Format;
  locale?: string;
  booked?: Booked;
  meetUrl?: string;
  reminder?: Reminder;
  notifyAttemptedAt?: string;
  notifiedAt?: string;
  startedAt?: string;
  startCompletedAt?: string;
  offeredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Ledger = { requests: Request[] };

export type NewRequest = Omit<Request,
  "id" | "calendarRevision" | "status" | "eventId" | "holdCleanup" | "pendingOwner" | "booked" | "meetUrl" | "reminder"
  | "notifyAttemptedAt" | "notifiedAt" | "startedAt" | "startCompletedAt"
  | "offeredAt" | "createdAt" | "updatedAt"> & { status?: "asked" | "offered" };
export type Patch = Partial<Pick<Request,
  "status" | "chatUid" | "eventId" | "offered" | "holdCleanup" | "name" | "location" | "allowOverlap" | "constraints" | "topic" | "format" | "locale">> & {
  pendingOwner?: PendingOwner | null;
  booked?: Booked | null;
  meetUrl?: string | null;
  reminder?: Reminder | null;
};

const STATUSES: readonly Status[] = ["asked", "offered", "booked", "dropped", "expired"];
const OPEN: readonly Status[] = ["asked", "offered"];
const FORMATS: readonly Format[] = ["meet", "in_person", "phone", "unknown"];
const OUTCOMES: readonly Reminder["outcome"][] = ["sent", "cancelled", "no-link"];
const PATCH_KEYS = [
  "status", "chatUid", "eventId", "offered", "holdCleanup", "name", "location", "allowOverlap", "constraints", "topic", "pendingOwner",
  "format", "locale", "booked", "meetUrl", "reminder",
];
// Keys a patch can clear with null.
const NULLABLE = ["pendingOwner", "booked", "meetUrl", "reminder"] as const;

const isDate = (t: unknown) => typeof t === "string" && !Number.isNaN(Date.parse(t));

function checkFormat(format: unknown): void {
  if (!FORMATS.includes(format as Format)) throw new Error(`format must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(format)}`);
}

function checkLocale(locale: unknown): void {
  if (typeof locale !== "string" || !locale.trim() || locale.length > 35) {
    throw new Error(`locale must be a language tag like pt-BR, got ${JSON.stringify(locale)}`);
  }
}

function checkBooked(b: Booked): void {
  if (!b || !isDate(b.start) || !isDate(b.end) || Date.parse(b.end) <= Date.parse(b.start)
    || typeof b.account !== "string" || !b.account) {
    throw new Error(`booked needs a valid start, a later end and an account: ${JSON.stringify(b)}`);
  }
}

function checkReminder(r: Reminder): void {
  if (!r || !isDate(r.at) || !OUTCOMES.includes(r.outcome)) {
    throw new Error(`reminder needs a valid at and an outcome of ${OUTCOMES.join(", ")}: ${JSON.stringify(r)}`);
  }
}

// Keep the full country code. Formatting never supplies missing identity digits.
export function normalizeHandle(h: string): string {
  if (typeof h !== "string") throw new Error("handle must be an E.164 phone or email");
  const value = h.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return value.toLowerCase();
  const phone = value.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{1,14}$/.test(phone)) return phone;
  throw new Error("handle must be an E.164 phone or email");
}

export function sameHandle(a: string, b: string): boolean {
  try { return normalizeHandle(a) === normalizeHandle(b); }
  catch { return false; }
}

// The person's `asked` or `offered` request; `statuses` narrows it.
export function findOpenByHandle(ledger: Ledger, handle: string, statuses: readonly Status[] = OPEN): Request | undefined {
  return ledger.requests.find((r) => statuses.includes(r.status) && sameHandle(r.handle, handle));
}

function findOpenBySource(ledger: Ledger, input: NewRequest): Request | undefined {
  return input.origin === "inbound" && input.sourceRowid !== undefined
    ? ledger.requests.find((r) => r.origin === "inbound" && r.sourceRowid === input.sourceRowid && OPEN.includes(r.status))
    : undefined;
}

export function findByChat(ledger: Ledger, chatUid: string, handle?: string): Request | undefined {
  // Resolve an open request for the sender even when it has not been linked
  // yet. This lets a replacement offer supersede a closed request in the chat.
  // An `asked` request has no group yet, so no chat ever resolves to one.
  if (handle !== undefined) {
    const openForHandle = findOpenByHandle(ledger, handle, ["offered"]);
    if (openForHandle && (openForHandle.chatUid === undefined || openForHandle.chatUid === chatUid)) {
      return openForHandle;
    }
  }
  // A chat remains a Meetly group after its request closes.
  return ledger.requests.findLast((r) => r.chatUid === chatUid && r.status === "offered")
    ?? ledger.requests.findLast((r) => r.chatUid === chatUid && r.status !== "asked");
}

function checkOffers(offered: unknown): Offer[] {
  if (!Array.isArray(offered) || offered.length === 0) throw new Error("offered must be a non-empty list");
  for (const o of offered as Offer[]) {
    if (!o || Number.isNaN(Date.parse(o.start)) || Number.isNaN(Date.parse(o.end))) {
      throw new Error(`each offer needs a valid start and end: ${JSON.stringify(o)}`);
    }
    if (typeof o.account !== "string" || !o.account) throw new Error(`each offer needs an account: ${JSON.stringify(o)}`);
  }
  return offered as Offer[];
}

export function addRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  input = { ...input, handle: normalizeHandle(input.handle) };
  if ("calendarRevision" in input) throw new Error("calendarRevision is managed by calendar.ts");
  for (const key of ["notifyAttemptedAt", "notifiedAt", "startedAt", "startCompletedAt"]) {
    if (key in input) throw new Error(`${key} is managed by ledger.ts delivery`);
  }
  if (input.origin !== "inbound" && input.origin !== "owner") throw new Error(`origin must be inbound or owner, got ${input.origin}`);
  if (typeof input.topic !== "string" || !input.topic.trim()) throw new Error("topic is required");
  if (!Number.isInteger(input.durationMin) || input.durationMin <= 0) throw new Error("durationMin must be a positive whole number");
  const status = input.status ?? "offered";
  if (status === "offered") checkOffers(input.offered);
  else if (status !== "asked") throw new Error(`a new request is asked or offered, got ${status}`);
  else if (input.offered?.length || input.chatUid !== undefined) throw new Error("an asked request has no offered times or chat yet");
  const format = input.format === undefined ? "unknown" : input.format;
  checkFormat(format);
  if (input.locale !== undefined) checkLocale(input.locale);
  const open = findOpenByHandle(ledger, input.handle);
  if (open) throw new Error(`open request ${open.id} already exists for this person; update it instead`);
  const at = new Date(now).toISOString();
  // A new offer is never booked: a booking, its link and its reminder are
  // only ever set through update, where they are validated.
  const { booked: _b, meetUrl: _m, reminder: _r, ...fields } = input as NewRequest & Partial<Pick<Request, "booked" | "meetUrl" | "reminder">>;
  const request: Request = status === "asked"
    ? { ...fields, offered: [], format, id, status, createdAt: at, updatedAt: at }
    : { ...fields, format, id, status, offeredAt: at, createdAt: at, updatedAt: at };
  return { requests: [...ledger.requests, request] };
}

// Save the latest offer for a person without creating a second open request.
// This makes a retry after holds were created safe: the existing request id
// (and its chat link, when one exists) remains stable. An offer saved over an
// `asked` request turns it into `offered`; asking again while one is open
// leaves the ledger as it is.
export function saveRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  input = { ...input, handle: normalizeHandle(input.handle) };
  const byHandle = findOpenByHandle(ledger, input.handle);
  const bySource = findOpenBySource(ledger, input);
  if (bySource && byHandle && bySource.id !== byHandle.id) throw new Error("resolved handle belongs to another open request");
  const existing = bySource ?? byHandle;
  if (!existing) return addRequest(ledger, input, now, id);
  if (input.status === "asked") return ledger;

  // Reuse addRequest's validation and timestamp behavior, then apply its new
  // offer to the existing record. An absent chatUid must not erase the link.
  const validated = addRequest(EMPTY, input, now, id).requests[0]!;
  const newHolds = new Set(validated.offered.flatMap((offer) => offer.holdId ? [`${offer.account}\0${offer.holdId}`] : []));
  const replacedHolds = existing.offered.flatMap((offer) => offer.holdId && !newHolds.has(`${offer.account}\0${offer.holdId}`)
    ? [{ holdId: offer.holdId, account: offer.account }]
    : []);
  const holdCleanup = uniqueCleanup([...(existing.holdCleanup ?? []), ...replacedHolds]);
  const replacement: Request = {
    ...existing,
    ...validated,
    id: existing.id,
    chatUid: input.chatUid ?? existing.chatUid,
    // A new offer that does not name a format keeps the one already answered.
    format: validated.format === "unknown" ? existing.format ?? "unknown" : validated.format,
    locale: input.locale ?? existing.locale,
    holdCleanup,
    createdAt: existing.createdAt,
    updatedAt: new Date(now).toISOString(),
  };
  return { requests: ledger.requests.map((r) => r.id === existing.id ? replacement : r) };
}

export function updateRequest(ledger: Ledger, id: string, patch: Patch, now: number): Ledger {
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) throw new Error(`unknown key: ${key} (allowed: ${PATCH_KEYS.join(", ")})`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`bad status: ${patch.status}`);
  if (patch.offered !== undefined) checkOffers(patch.offered);
  const pending = patch.pendingOwner;
  if (pending) {
    if ([pending.start, pending.end, pending.askedAt].some((t) => typeof t !== "string" || Number.isNaN(Date.parse(t)))) {
      throw new Error(`pendingOwner needs valid start, end and askedAt: ${JSON.stringify(pending)}`);
    }
  }
  if (patch.format !== undefined) checkFormat(patch.format);
  if (patch.locale !== undefined) checkLocale(patch.locale);
  if (patch.booked) checkBooked(patch.booked);
  if (patch.reminder) checkReminder(patch.reminder);
  if (patch.meetUrl !== undefined && patch.meetUrl !== null && !isMeetUrl(patch.meetUrl)) {
    throw new Error(`meetUrl must be a Google Meet link (https://meet.google.com/xxx-xxxx-xxx), got ${JSON.stringify(patch.meetUrl)}`);
  }
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const at = new Date(now).toISOString();
  const updated: Request = { ...ledger.requests[index]!, updatedAt: at };
  if (updated.status === "asked" && patch.chatUid !== undefined) throw new Error("an asked request has no chat until the owner says yes and it is offered");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (NULLABLE as readonly string[]).includes(key)) delete updated[key as (typeof NULLABLE)[number]];
    else if (value !== undefined) (updated as Record<string, unknown>)[key] = value;
  }
  // A link belongs to a Meet: moving to another format drops it, and a link
  // is never set on a meeting that is not one.
  if (updated.meetUrl !== undefined && updated.format !== "meet") {
    if (patch.meetUrl) throw new Error(`meetUrl is only for a meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.meetUrl;
  }
  if (patch.offered !== undefined) updated.offeredAt = at;
  const requests = [...ledger.requests];
  requests[index] = updated;
  return { requests };
}

// Owner notices can retry until completed; group starts need an explicit clear.
export function recordDelivery(ledger: Ledger, id: string, kind: string, action: string, now: number): Ledger {
  if (!["notify", "start"].includes(kind) || !["begin", "complete", "clear"].includes(action)) {
    throw new Error("delivery needs --kind notify|start and --action begin|complete|clear");
  }
  const request = ledger.requests.find((r) => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  if (request.status !== (kind === "notify" ? "asked" : "offered")) throw new Error(`cannot ${kind} for ${request.status} request`);
  const [attempt, completed] = kind === "notify"
    ? ["notifyAttemptedAt", "notifiedAt"] as const : ["startedAt", "startCompletedAt"] as const;
  const at = new Date(now).toISOString();
  const updated = { ...request, updatedAt: at };
  if (action === "clear") {
    if (kind !== "start" || request.chatUid) throw new Error("only an unlinked group start can be cleared");
    delete updated[attempt];
    delete updated[completed];
  } else if (action === "begin") {
    if (kind === "start" && (request.startedAt || request.chatUid)) throw new Error("group start already attempted; only the owner can authorize clearing it");
    if (request[completed]) throw new Error(`${kind} delivery already completed`);
    updated[attempt] = at;
  } else {
    if (!request[attempt]) throw new Error(`${kind} delivery has no recorded attempt`);
    updated[completed] ??= at;
  }
  return { requests: ledger.requests.map((r) => r.id === id ? updated : r) };
}

// Open requests past the hold window: an `offered` one from its offer, an
// `asked` one from when it was saved.
export function expiredRequests(ledger: Ledger, hours: number, now: number): Request[] {
  return ledger.requests.filter((r) => OPEN.includes(r.status)
    && now - Date.parse(r.status === "asked" ? r.createdAt : r.offeredAt!) >= hours * 3600_000);
}

// Requests waiting for the owner's yes.
export function askedList(ledger: Ledger, unnotified = false): Request[] {
  return ledger.requests.filter((r) => r.status === "asked" && (!unnotified || !r.notifiedAt));
}

// Open requests waiting for the owner to confirm an out-of-hours time.
export function pendingOwnerList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => r.status === "offered" && r.pendingOwner !== undefined);
}

// Booked Meets whose link is due in the group: from `leadMin` before the
// start until `graceMin` after it, once.
export function dueReminders(ledger: Ledger, now: number, leadMin: number, graceMin = 5): Request[] {
  return ledger.requests.filter((r) => {
    if (r.status !== "booked" || r.format !== "meet" || !r.meetUrl || !r.booked || r.reminder) return false;
    const start = Date.parse(r.booked.start);
    return now >= start - leadMin * 60_000 && now < start + graceMin * 60_000;
  });
}

export function cleanupList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => (r.holdCleanup?.length ?? 0) > 0);
}

const EMPTY: Ledger = { requests: [] };

function jsonArg(values: { json?: string; "json-file"?: string }): any {
  const text = values.json ?? (values["json-file"] !== undefined ? readFileSync(values["json-file"], "utf8") : undefined);
  if (text === undefined) throw new Error("pass --json '<object>' or --json-file F");
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the JSON must be an object");
  return value;
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: {
        handle: { type: "string" },
        chat: { type: "string" },
        id: { type: "string" },
        json: { type: "string" },
        "json-file": { type: "string" },
        hours: { type: "string" },
        "lead-min": { type: "string" },
        status: { type: "string" },
        unnotified: { type: "boolean" },
        kind: { type: "string" },
        action: { type: "string" },
      },
    });
    const path = file("ledger.json");
    const now = Date.now();
    switch (cmd) {
      case "find": {
        const ledger = readJson<Ledger>(path, EMPTY);
        if (values.chat !== undefined) return { request: findByChat(ledger, values.chat, values.handle) ?? null };
        if (values.handle !== undefined) {
          if (values.status !== undefined && !OPEN.includes(values.status as Status)) throw new Error(`--status must be ${OPEN.join(" or ")}`);
          return { request: findOpenByHandle(ledger, values.handle, values.status ? [values.status as Status] : OPEN) ?? null };
        }
        throw new Error("usage: ledger.ts find --handle H [--status asked|offered] | --chat U");
      }
      case "add": {
        const input = jsonArg(values);
        const id = requestId();
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => addRequest(l, input, now, id));
        return { request: ledger.requests.find((r) => r.id === id) };
      }
      case "save": {
        const input = jsonArg(values);
        const id = requestId();
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => saveRequest(l, input, now, id));
        return { request: findOpenByHandle(ledger, input.handle) ?? findOpenBySource(ledger, input) };
      }
      case "update": {
        if (!values.id) throw new Error("usage: ledger.ts update --id X --json '<patch>'");
        const patch = jsonArg(values);
        for (const key of ["status", "eventId", "offered", "holdCleanup", "booked", "meetUrl", "reminder", "calendarRevision", "format", "location"]) {
          if (key in patch) throw new Error(`${key} is managed by calendar.ts or reminder-check.ts`);
        }
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => updateRequest(l, values.id!, patch, now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "expired": {
        const hours = values.hours !== undefined ? Number(values.hours) : holdHours();
        if (!Number.isFinite(hours) || hours < 0) throw new Error(`--hours must be a number >= 0, got ${values.hours}`);
        return { requests: expiredRequests(readJson<Ledger>(path, EMPTY), hours, now) };
      }
      case "delivery": {
        if (!values.id) throw new Error("delivery needs --id X");
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => recordDelivery(l, values.id!, values.kind ?? "", values.action ?? "", now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "asked":
        return { requests: askedList(readJson<Ledger>(path, EMPTY), values.unnotified) };
      case "pending":
        return { requests: pendingOwnerList(readJson<Ledger>(path, EMPTY)) };
      case "cleanup":
        return { requests: cleanupList(readJson<Ledger>(path, EMPTY)).map((r) => ({ id: r.id, holdCleanup: r.holdCleanup })) };
      case "reminders": {
        const lead = values["lead-min"] !== undefined ? Number(values["lead-min"]) : reminderLeadMin();
        if (!Number.isFinite(lead) || lead <= 0) throw new Error(`--lead-min must be a number > 0, got ${values["lead-min"]}`);
        return { requests: dueReminders(readJson<Ledger>(path, EMPTY), now, lead) };
      }
      default:
        throw new Error("usage: ledger.ts find | add | save | update | delivery | expired | asked | pending | cleanup | reminders");
    }
  });
}
