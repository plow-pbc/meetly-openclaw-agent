// Meetly's record of every scheduling request: who, which group, which times
// were offered and held, and how it ended. Cleanup records event ids or exact
// operation markers for creates whose event ids were never received.
import { withoutPrivateTravel } from "./calendar-output.ts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { holdHours, loadConfig, reminderLeadMin } from "./config.ts";
import { isMeetUrl } from "./event.ts";
import { file } from "./paths.ts";
import { uniqueEvents, type EventRef } from "./busy.ts";
import { checkTravel, type Travel } from "./travel.ts";
import { DAYS } from "./time.ts";
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
// One question or out-of-hours time waiting for the owner's answer.
export const OWNER_QUESTION_LIMIT = 500;
export type PendingOwner = { askedAt: string; answerAttemptedAt?: string } & ({ start: string; end: string } | { question: string });
export function intersectConstraints(owner: Constraints = {}, guest: Constraints = {}): Constraints {
  return {
    days: owner.days && guest.days ? owner.days.filter(d => guest.days!.includes(d)) : owner.days ?? guest.days,
    after: [owner.after, guest.after].filter(Boolean).sort().at(-1),
    before: [owner.before, guest.before].filter(Boolean).sort()[0],
    from: [owner.from, guest.from].filter(Boolean).sort().at(-1),
    to: [owner.to, guest.to].filter(Boolean).sort()[0],
  };
}

export type Meal = "lunch" | "dinner" | "coffee";
// How the meeting happens. `unknown` until the request or an answer says it.
export type Format = "meet" | "in_person" | "phone" | "unknown";
// The booked event's time, and the Google account it lives on.
export type Booked = { start: string; end: string; account: string };
// The join-time reminder was handled: sent, or not sent for good.
export type Reminder = { at: string; outcome: "sent" | "cancelled" | "no-link" };

export type Request = {
  id: string;
  channel: "text" | "email";
  origin: "inbound" | "owner" | "owner-group";
  handle: string;
  name?: string;
  sourceRowid?: number;
  chatUid?: string;
  calendarRevision?: string;
  doNotContact?: boolean;
  lastGuestReplyAt?: string;
  lastNudge?: { fingerprint: string; at: string };
  log?: { at: string; text: string }[];
  topic: string;
  location?: string;
  travel?: Travel;
  travelEvents?: HoldRef[];
  durationMin: number;
  meal?: Meal;
  // The owner's conditions, kept for every offer of this request.
  constraints?: Constraints;
  // Weekdays the guest has ruled out, retained across searches and booking.
  excludedDays?: string[];
  // Times the person proposed; only the first offer uses them.
  proposed?: Constraints;
  allowOverlap?: EventRef[];
  askDetails?: boolean;
  offered: Offer[];
  reoffer?: { offered: Offer[]; offeredAt: string };
  status: Status;
  eventId?: string;
  holdCleanup?: HoldCleanup[];
  pendingOwner?: PendingOwner;
  format?: Format;
  locale?: string;
  booked?: Booked;
  meetUrl?: string;
  reminder?: Reminder;
  startedAt?: string;
  startCompletedAt?: string;
  // Reserved before returning a details question, including uncertain delivery.
  detailsAskedAt?: string;
  offeredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export const currentOffers = (request: Request): Offer[] => request.status === "booked"
  ? request.reoffer?.offered ?? [] : request.status === "offered" ? request.offered : [];
export const requestHolds = (request: Request): HoldRef[] => currentOffers(request)
  .flatMap(o => o.holdId ? [{ holdId: o.holdId, account: o.account }] : []);
export const requestEvents = (request: Request): HoldRef[] => [
  ...requestHolds(request),
  ...(request.holdCleanup ?? []).flatMap(ref => ref.holdId ? [{ holdId: ref.holdId, account: ref.account }] : []),
  ...(request.status === "booked" ? request.travelEvents ?? [] : []),
  ...(request.status === "booked" && request.eventId && request.booked ? [{ holdId: request.eventId, account: request.booked.account }] : []),
];

export type Ledger = { requests: Request[] };

export type NewRequest = Omit<Request,
  "travelEvents" | "id" | "channel" | "doNotContact" | "lastGuestReplyAt" | "lastNudge" | "log" | "reoffer" | "calendarRevision" | "status" | "eventId" | "holdCleanup" | "pendingOwner" | "booked" | "meetUrl" | "reminder"
  | "startedAt" | "startCompletedAt" | "detailsAskedAt"
  | "offeredAt" | "createdAt" | "updatedAt"> & { channel?: Request["channel"]; status?: "asked" | "offered" };
export type Patch = Partial<Pick<Request,
  "travel" | "travelEvents" | "status" | "chatUid" | "eventId" | "offered" | "holdCleanup" | "name" | "location" | "allowOverlap" | "constraints" | "excludedDays" | "topic" | "format" | "locale">> & {
  reoffer?: Request["reoffer"] | null;
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
  "travel", "travelEvents", "status", "chatUid", "eventId", "offered", "holdCleanup", "name", "location", "allowOverlap", "constraints", "excludedDays", "topic", "pendingOwner",
  "format", "locale", "booked", "meetUrl", "reminder", "reoffer",
];
// Keys a patch can clear with null.
const NULLABLE = ["reoffer", "pendingOwner", "booked", "meetUrl", "reminder"] as const;

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

export function doNotContact(ledger: Ledger, handle: string): boolean {
  return ledger.requests.some(r => sameHandle(r.handle, handle) && r.doNotContact === true);
}

export class ContactConfirmationRequired extends Error {
  constructor() { super("This person is marked do not contact. Confirm in the owner's DM before scheduling."); }
}

export function checkContact(ledger: Ledger, handle: string, confirmed = false): void {
  if (doNotContact(ledger, handle) && !confirmed) throw new ContactConfirmationRequired();
}

export const nudgeFingerprint = (reason: string, since: string): string => JSON.stringify([reason, since]);

const LOG_LIMIT = 20;
export function appendLog(request: Request, text: string, now: number): Request {
  return { ...request, log: [...(request.log ?? []), { at: new Date(now).toISOString(), text }].slice(-LOG_LIMIT) };
}

function logChange(before: Request, after: Request, now: number): Request {
  const changes: string[] = [];
  if (before.status !== after.status) changes.push(`Request ${after.status}`);
  else if (JSON.stringify(before.booked) !== JSON.stringify(after.booked)) changes.push("Meeting moved");
  if (before.offeredAt !== after.offeredAt || JSON.stringify(before.offered) !== JSON.stringify(after.offered)) changes.push("Times offered");
  if (JSON.stringify(before.reoffer) !== JSON.stringify(after.reoffer)) changes.push(after.reoffer ? "Replacement times offered" : "Replacement offer closed");
  if (before.pendingOwner?.askedAt !== after.pendingOwner?.askedAt || JSON.stringify(before.pendingOwner) !== JSON.stringify(after.pendingOwner)) {
    if (!after.pendingOwner) changes.push("Owner question resolved");
    else if (!before.pendingOwner || before.pendingOwner.askedAt !== after.pendingOwner.askedAt) changes.push("Waiting for owner answer");
  }
  return changes.length ? appendLog(after, changes.join("; "), now) : after;
}

export function setDoNotContact(ledger: Ledger, handle: string, blocked: boolean, now: number, name?: string): Ledger {
  handle = normalizeHandle(handle);
  if (!ledger.requests.some(r => sameHandle(r.handle, handle))) {
    if (!blocked) return ledger;
    // A closed preference record keeps a new contact's flag in the same ledger.
    const id = requestId();
    ledger = addRequest(ledger, { origin: "owner", handle, name, status: "asked", topic: "Scheduling preference", durationMin: 30, offered: [] }, now, id);
    ledger = { requests: ledger.requests.map(r => r.id === id ? { ...r, status: "dropped", log: [] } : r) };
  }
  return { requests: ledger.requests.map(r => sameHandle(r.handle, handle) && !!r.doNotContact !== blocked
    ? appendLog({ ...r, doNotContact: blocked, updatedAt: new Date(now).toISOString() }, blocked ? "Do not contact enabled" : "Do not contact cleared", now) : r) };
}

// Monitoring and question-delivery metadata do not invalidate a scheduling action's snapshot.
export function sameRequest(a: Request | undefined, b: Request | undefined): boolean {
  if (!a || !b) return a === b;
  const { lastNudge: _an, log: _al, lastGuestReplyAt: _ar, detailsAskedAt: _ad, updatedAt: _au, ...left } = a;
  const { lastNudge: _bn, log: _bl, lastGuestReplyAt: _br, detailsAskedAt: _bd, updatedAt: _bu, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function recordGuestReply(ledger: Ledger, chat: string, sender: string, at: number): Ledger {
  if (!Number.isFinite(at)) return ledger;
  const request = findByChat(ledger, chat);
  if (!request || (request.channel === "email" ? !sender || sender === "plow-owner" : !sameHandle(request.handle, sender)) || !["offered", "booked"].includes(request.status)
    || (request.lastGuestReplyAt !== undefined && at <= Date.parse(request.lastGuestReplyAt)) || at < Date.parse(request.reoffer?.offeredAt ?? request.offeredAt ?? request.createdAt)) return ledger;
  return { requests: ledger.requests.map(r => r.id === request.id
    ? appendLog({ ...r, lastGuestReplyAt: new Date(at).toISOString() }, "Guest replied", at) : r) };
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

function checkExcludedDays(days: unknown): void {
  if (!Array.isArray(days) || days.some(day => !DAYS.includes(day))) throw new Error("excludedDays must contain weekdays mon–sun");
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

export function requireDuration(value: number | undefined): number {
  if (!Number.isInteger(value) || value! <= 0) throw new Error("Set durationMin on the request to a positive whole number of minutes before saving or offering it.");
  return value!;
}

export function addRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  input = { ...input, handle: normalizeHandle(input.handle) };
  if (input.origin === "inbound" && input.status === "asked" && doNotContact(ledger, input.handle)) return ledger;
  for (const key of ["doNotContact", "lastGuestReplyAt", "lastNudge", "log"]) {
    if (key in input) throw new Error(`${key} is managed by pipeline.ts`);
  }
  const channel = input.channel ?? "text";
  if (channel !== "text" && channel !== "email") throw new Error("channel must be text or email");
  if (channel === "email" && !input.handle.includes("@")) throw new Error("email requests need an email address");
  for (const key of ["calendarRevision", "reoffer", "travelEvents"]) {
    if (key in input) throw new Error(`${key} is managed by calendar.ts`);
  }
  if ("detailsAskedAt" in input) throw new Error("detailsAskedAt is managed by request-view.ts");
  for (const key of ["startedAt", "startCompletedAt"]) {
    if (key in input) throw new Error(`${key} is managed by ledger.ts delivery`);
  }
  if (input.origin !== "inbound" && input.origin !== "owner" && input.origin !== "owner-group") throw new Error(`origin must be inbound, owner or owner-group, got ${input.origin}`);
  if (typeof input.topic !== "string" || !input.topic.trim()) throw new Error("topic is required");
  requireDuration(input.durationMin);
  if (input.meal !== undefined && !["lunch", "dinner", "coffee"].includes(input.meal)) throw new Error("meal must be lunch, dinner or coffee");
  if (input.excludedDays !== undefined) checkExcludedDays(input.excludedDays);
  const status = input.status ?? "offered";
  if (status === "offered") checkOffers(input.offered);
  else if (status !== "asked") throw new Error(`a new request is asked or offered, got ${status}`);
  else if (input.offered?.length || input.chatUid !== undefined) throw new Error("an asked request has no offered times or chat yet");
  const format = input.format === undefined ? "unknown" : input.format;
  checkFormat(format);
  if (input.locale !== undefined) checkLocale(input.locale);
  if (input.travel !== undefined) checkTravel(input.travel);
  const open = findOpenByHandle(ledger, input.handle);
  if (open) throw new Error(`open request ${open.id} already exists for this person; update it instead`);
  const at = new Date(now).toISOString();
  // A new offer is never booked: a booking, its link and its reminder are
  // only ever set through update, where they are validated.
  const { booked: _b, meetUrl: _m, reminder: _r, ...fields } = input as NewRequest & Partial<Pick<Request, "booked" | "meetUrl" | "reminder">>;
  const request: Request = status === "asked"
    ? { ...fields, channel, offered: [], format, id, status, createdAt: at, updatedAt: at }
    : { ...fields, channel, format, id, status, offeredAt: at, createdAt: at, updatedAt: at };
  if (doNotContact(ledger, input.handle)) request.doNotContact = true;
  return { requests: [...ledger.requests, appendLog(request, `Request ${status}`, now)] };
}

// Save the latest offer for a person without creating a second open request.
// This makes a retry after holds were created safe: the existing request id
// (and its chat link, when one exists) remains stable. An offer saved over an
// `asked` request turns it into `offered`; asking again while one is open
// leaves the ledger as it is.
export function saveRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  input = { ...input, handle: normalizeHandle(input.handle) };
  if (input.origin === "inbound" && input.status === "asked" && doNotContact(ledger, input.handle)) return ledger;
  const byHandle = findOpenByHandle(ledger, input.handle);
  const bySource = findOpenBySource(ledger, input);
  if (bySource && byHandle && bySource.id !== byHandle.id) throw new Error("resolved handle belongs to another open request");
  const existing = bySource ?? byHandle;
  if (!existing) return addRequest(ledger, input, now, id);
  if (input.channel !== undefined && input.channel !== existing.channel) throw new Error("an open request cannot change channel");
  if (input.status === "asked") return ledger;

  // Reuse addRequest's validation and timestamp behavior, then apply its new
  // offer to the existing record. An absent chatUid must not erase the link.
  if (existing.channel === "email" && existing.chatUid && input.chatUid && input.chatUid !== existing.chatUid) throw new Error("an email request cannot move to another thread");
  input = { ...input, channel: existing.channel, name: input.name ?? existing.name, origin: existing.origin, chatUid: input.chatUid ?? existing.chatUid,
    askDetails: input.askDetails ?? existing.askDetails,
    travel: existing.travel?.override && input.format !== "meet" && input.format !== "phone" ? existing.travel : input.travel ?? existing.travel,
    allowOverlap: uniqueEvents([...(existing.allowOverlap ?? []), ...(input.allowOverlap ?? [])]) };
  if (existing.chatUid && input.chatUid !== existing.chatUid) throw new Error("a request cannot move to another chat");
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
    log: existing.log,
    createdAt: existing.createdAt,
    updatedAt: new Date(now).toISOString(),
  };
  return { requests: ledger.requests.map((r) => r.id === existing.id ? logChange(existing, replacement, now) : r) };
}

export function updateRequest(ledger: Ledger, id: string, patch: Patch, now: number): Ledger {
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) throw new Error(`unknown key: ${key} (allowed: ${PATCH_KEYS.join(", ")})`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`bad status: ${patch.status}`);
  if (patch.excludedDays !== undefined) checkExcludedDays(patch.excludedDays);
  if (patch.offered !== undefined) checkOffers(patch.offered);
  if (patch.reoffer) {
    checkOffers(patch.reoffer.offered);
    if (!isDate(patch.reoffer.offeredAt)) throw new Error("reoffer needs a valid offeredAt");
  }
  const pending = patch.pendingOwner;
  if (pending) {
    if (!isDate(pending.askedAt) || ("question" in pending
      ? typeof pending.question !== "string" || !pending.question.trim() || pending.question.length > OWNER_QUESTION_LIMIT || "start" in pending || "end" in pending
      : !isDate(pending.start) || !isDate(pending.end))) {
      throw new Error("pendingOwner needs askedAt and either a short question or valid start and end");
    }
  }
  if (patch.travel !== undefined) checkTravel(patch.travel);
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
  if (updated.channel === "email" && updated.chatUid && patch.chatUid !== undefined && patch.chatUid !== updated.chatUid) throw new Error("an email request cannot move to another thread");
  if (updated.chatUid && patch.chatUid !== undefined && patch.chatUid !== updated.chatUid) throw new Error("a request cannot move to another chat");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (NULLABLE as readonly string[]).includes(key)) delete updated[key as (typeof NULLABLE)[number]];
    else if (value !== undefined) (updated as Record<string, unknown>)[key] = value;
  }
  if (updated.reoffer && updated.status !== "booked") throw new Error("reoffer needs a booked request");
  // A link belongs to a Meet: moving to another format drops it, and a link
  // is never set on a meeting that is not one.
  if (updated.meetUrl !== undefined && updated.format !== "meet") {
    if (patch.meetUrl) throw new Error(`meetUrl is only for a meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.meetUrl;
  }
  if (patch.offered !== undefined) updated.offeredAt = at;
  const requests = [...ledger.requests];
  requests[index] = logChange(ledger.requests[index]!, updated, now);
  return { requests };
}

// Group starts and answers need an explicit clear before retrying an uncertain send.
export function recordDelivery(ledger: Ledger, id: string, kind: string, action: string, now: number): Ledger {
  if (!["start", "answer"].includes(kind) || !["begin", "complete", "clear"].includes(action)) {
    throw new Error("delivery needs --kind start|answer and --action begin|complete|clear");
  }
  const request = ledger.requests.find((r) => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  if (kind === "answer") {
    const pending = request.pendingOwner;
    if (!request.chatUid || !["offered", "booked"].includes(request.status) || !pending || action === "complete") {
      throw new Error("answer delivery needs a pending question or time approval and begin or clear");
    }
    if (action === "begin" && pending.answerAttemptedAt) throw new Error("answer delivery already attempted; only the owner can authorize clearing it");
    const { answerAttemptedAt, ...question } = pending;
    return updateRequest(ledger, id, { pendingOwner: action === "begin" ? { ...question, answerAttemptedAt: new Date(now).toISOString() } : question }, now);
  }
  if (request.status !== "offered") throw new Error(`cannot ${kind} for ${request.status} request`);
  const [attempt, completed] = ["startedAt", "startCompletedAt"] as const;
  const at = new Date(now).toISOString();
  const updated = { ...request, updatedAt: at };
  if (action === "clear") {
    if (request.chatUid) throw new Error("only an unlinked group start can be cleared");
    delete updated[attempt];
    delete updated[completed];
  } else if (action === "begin") {
    if (request.startedAt || request.chatUid) throw new Error("group start already attempted. Do not send or clear this attempt. Only an explicit owner retry instruction can authorize clearing it.");
    if (request[completed]) throw new Error(`${kind} delivery already completed`);
    updated[attempt] = at;
  } else {
    if (!request[attempt]) throw new Error(`${kind} delivery has no recorded attempt`);
    updated[completed] ??= at;
  }
  return { requests: ledger.requests.map((r) => r.id === id ? updated : r) };
}

// Age offers and booked replacement offers from their own hold timestamps;
// an unanswered request ages from when it was saved.
export function expiredRequests(ledger: Ledger, hours: number, now: number): Request[] {
  return ledger.requests.filter((r) => (OPEN.includes(r.status) || (r.status === "booked" && r.reoffer))
    && now - Date.parse(r.status === "booked" ? r.reoffer!.offeredAt : r.status === "asked" ? r.createdAt : r.offeredAt!) >= hours * 3600_000);
}

// Requests waiting for the owner's yes.
export function askedList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => r.status === "asked");
}

// Requests waiting for a question's answer or an out-of-hours approval.
export function pendingOwnerList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => r.pendingOwner !== undefined
    && (r.status === "offered" || r.status === "booked"));
}

// Booked text-thread Meets whose link is due in the group: from `leadMin` before the
// start until `graceMin` after it, once.
export function dueReminders(ledger: Ledger, now: number, leadMin: number, graceMin = 5): Request[] {
  return ledger.requests.filter((r) => {
    if (r.channel === "email" || r.status !== "booked" || r.format !== "meet" || !r.meetUrl || !r.booked || r.reminder) return false;
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
  if ("allowOverlap" in value) throw new Error("allowOverlap is managed by calendar.ts; use the owner's offer flow");
  return value;
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: {
        handle: { type: "string" },
        name: { type: "string" },
        chat: { type: "string" },
        id: { type: "string" },
        json: { type: "string" },
        "json-file": { type: "string" },
        hours: { type: "string" },
        "lead-min": { type: "string" },
        status: { type: "string" },
        kind: { type: "string" },
        action: { type: "string" },
      },
    });
    const path = file("ledger.json");
    const now = Date.now();
    switch (cmd) {
      case "find": {
        const ledger = readJson<Ledger>(path, EMPTY);
        if (values.chat !== undefined) {
          const chat = values.chat.trim().replace(/^plow:/, "");
          return { request: findByChat(ledger, chat, values.handle) ?? null };
        }
        if (values.handle !== undefined) {
          if (values.status !== undefined && !OPEN.includes(values.status as Status)) throw new Error(`--status must be ${OPEN.join(" or ")}`);
          return { request: findOpenByHandle(ledger, values.handle, values.status ? [values.status as Status] : OPEN) ?? null };
        }
        if (values.name !== undefined) {
          const name = values.name.trim().toLowerCase();
          const matches = ledger.requests.filter(r => OPEN.includes(r.status) && name && r.name?.trim().toLowerCase() === name);
          if (matches.length > 1) throw new Error("Ambiguous guest name; ask the owner which meeting they mean.");
          return { request: matches[0] ?? null };
        }
        throw new Error("usage: ledger.ts find --handle H [--status asked|offered] | --chat U | --name N");
      }
      case "add": {
        const input = jsonArg(values);
        if ("allowOverlap" in input || "allowOverlapTitles" in input) throw new Error("Overlap authorization requires the owner DM tool meetly_offer_owner_dm.");
        const id = requestId();
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => addRequest(l, input, now, id));
        if (input.origin === "inbound" && input.status === "asked" && doNotContact(ledger, input.handle)) return { skipped: "do-not-contact" };
        return { request: ledger.requests.find((r) => r.id === id) };
      }
      case "save": {
        const input = jsonArg(values);
        if ("allowOverlap" in input || "allowOverlapTitles" in input) throw new Error("Overlap authorization requires the owner DM tool meetly_offer_owner_dm.");
        const id = requestId();
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => saveRequest(l, input, now, id));
        if (input.origin === "inbound" && input.status === "asked" && doNotContact(ledger, input.handle)) return { skipped: "do-not-contact" };
        return { request: findOpenByHandle(ledger, input.handle) ?? findOpenBySource(ledger, input) };
      }
      case "update": {
        if (!values.id) throw new Error("usage: ledger.ts update --id X --json '<patch>'");
        const patch = jsonArg(values);
        for (const key of ["travel", "travelEvents", "status", "eventId", "offered", "reoffer", "holdCleanup", "booked", "meetUrl", "reminder", "calendarRevision", "format", "location", "durationMin", "allowOverlap"]) {
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
        const request = ledger.requests.find((r) => r.id === values.id);
        if (values.kind !== "start") return { request };
        const delivery = values.action === "begin"
          ? { state: "reserved", sendNow: true, instruction: "Send the opener now, exactly once, using the channel's start tool. This call reserved the attempt; it did not send anything. Do not begin or clear again, and do not treat the startedAt just returned by this call as an earlier attempt. Record complete only after the send returns success or unknown delivery." }
          : values.action === "clear"
            ? { state: "cleared", sendNow: false, instruction: "Start reservation cleared. Run begin once before sending; retry only on the owner's explicit instruction." }
            : { state: "completed", sendNow: false, instruction: "The send outcome is recorded. Do not send again. Link the returned chat uid if known; unknown delivery must not be retried automatically." };
        return { request, delivery };
      }
      case "booked":
        return { requests: readJson<Ledger>(path, EMPTY).requests.filter(r => r.status === "booked") };
      case "asked":
        return { requests: askedList(readJson<Ledger>(path, EMPTY)) };
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
        throw new Error("usage: ledger.ts find | add | save | update | delivery | expired | asked | booked | pending | cleanup | reminders");
    }
  }, withoutPrivateTravel);
}
