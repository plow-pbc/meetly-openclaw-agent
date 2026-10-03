// Scheduling actions scoped to the sender and conversation supplied by OpenClaw.
import { fetchBusy, type BusyResult } from "./busy.ts";
import { loadConfig, parseTime, type Config, type Day } from "./config.ts";
import { lookupContact } from "./contact.ts";
import { calendarAction, type CalendarAction } from "./calendar.ts";
import { nudgeFingerprint, sameRequest, currentOffers, requestEvents, findByChat, meetingTopic, intersectConstraints, sameHandle, OWNER_QUESTION_LIMIT, updateRequest, type Constraints, type Format, type Ledger, type Patch, type PendingOwner, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { checkTime, findSlots, localeFormatter, withinConstraints, type Slot, type SlotQuery } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";
import { DAYS, localIso, nextWeek } from "./time.ts";
import { view } from "./request-view.ts";

export type GuestContext = { messageChannel?: string; agentAccountId?: string; nativeChannelId?: string; deliveryContext?: { to?: string }; requesterSenderId?: string };
export type GuestAction = "view" | "pick" | "other_times" | "format" | "ask_owner" | "decline";
export type GuestArgs = Constraints & { excludedDays?: string[]; next_week?: string; start?: string; question?: string; format?: Format; location?: string };
type SendOwner = (text: string) => Promise<void>;
const EMPTY: Ledger = { requests: [] };

const chatId = (ctx: GuestContext) => ctx.nativeChannelId ?? ctx.deliveryContext?.to?.replace(/^plow:/, "");

function current(ledger: Ledger, ctx: GuestContext): Request | undefined {
  const chat = chatId(ctx);
  const sender = ctx.requesterSenderId;
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || !chat || !sender) return;
  const request = findByChat(ledger, chat);
  return request && sameHandle(request.handle, sender) ? request : undefined;
}

function patch(request: Request, change: Patch): Request {
  return updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
    unchanged(request, l.requests.find(r => r.id === request.id)!);
    return updateRequest(l, request.id, change, Date.now());
  })
    .requests.find(r => r.id === request.id)!;
}

// Recheck the guest's authorized snapshot inside the writer lock. A concurrent
// booking or replacement must not authorize a pick from a stale offer.
function unchanged(request: Request, latest: Request): void {
  if (!sameRequest(request, latest)) throw new Error("request changed");
}

const write = (request: Request, action: CalendarAction) => calendarAction(request.id, action, {
  validate: latest => unchanged(request, latest),
});

// Remove only this request's holds and booked event, with their accounts.
async function busyFor(request: Request, config: Config, from: string, to: string): Promise<BusyResult> {
  const result = await fetchBusy(config, { from, to });
  if (result.degraded.length) throw new Error("calendar unavailable");
  return { ...result, busy: result.busy.filter(b => !requestEvents(request).some(h => h.holdId === b.id && h.account === b.account)) };
}

function preferences(args: GuestArgs, timezone: string): Constraints {
  const out: Constraints = {};
  if (args.days !== undefined) {
    if (!Array.isArray(args.days) || !args.days.every(d => (DAYS as readonly string[]).includes(d))) throw new Error("invalid days");
    out.days = args.days;
  }
  for (const key of ["after", "before"] as const) if (args[key] !== undefined) out[key] = parseTime(args[key]);
  for (const key of ["from", "to"] as const) if (args[key] !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args[key])) throw new Error("invalid date");
    out[key] = args[key];
  }
  return args.next_week === undefined ? out : intersectConstraints(out, nextWeek(args.next_week, timezone));
}

async function check(request: Request, config: Config, start: string) {
  const query = { now: Date.now(), config, meal: request.meal, durationMin: request.durationMin, start, locale: request.locale, allowOverlap: request.allowOverlap };
  const { slot } = checkTime({ ...query, busy: [] });
  const busy = await busyFor(request, config, slot.start, slot.end);
  const checked = checkTime({ ...query, ...busy });
  const overlap = busy.busy.some(b => b.id && request.allowOverlap?.includes(b.id)
    && Date.parse(b.start) < Date.parse(slot.end) && Date.parse(b.end) > Date.parse(slot.start));
  return { ...checked, overlap };
}

async function notifyOwner(request: Request, config: Config, change: "moved" | "cancelled", sendOwner?: SendOwner) {
  const when = localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(request.booked!.start));
  const subject = `${meetingTopic(request)} with ${request.name ?? request.handle}`;
  const text = change === "moved" ? `${subject} moved to ${when} (${config.timezone}).`
    : request.holdCleanup?.length ? `${request.name ?? request.handle} requested cancellation of ${meetingTopic(request)} on ${when} (${config.timezone}); calendar cleanup is pending.`
    : `${request.name ?? request.handle} cancelled ${meetingTopic(request)} on ${when} (${config.timezone}).`;
  try {
    if (!sendOwner) throw new Error("owner messaging unavailable");
    await sendOwner(text);
    return { ownerNotified: true };
  } catch {
    return { ownerNotified: false, warning: "owner-notification-unconfirmed" };
  }
}

async function pick(request: Request, config: Config, start: string, sendOwner?: SendOwner) {
  const offer = currentOffers(request).find(o => Date.parse(o.start) === Date.parse(start));
  if (!offer) return { error: "Choose one of the currently offered start times." };
  const checked = await check(request, config, offer.start);
  if (!checked.free || checked.outsideHours || !withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) return { error: "That time is no longer available. Ask for other times." };
  if (request.status === "booked") {
    const result = await write(request, { action: "book", start: offer.start, end: offer.end });
    request = result.request;
    return { ...view(request, config), invitationUpdated: "invitationUpdated" in result && result.invitationUpdated === true,
      overlappedWithOwnerApproval: checked.overlap, ...await notifyOwner(request, config, "moved", sendOwner) };
  }
  const contact = await lookupContact(request.handle);
  const email = request.handle.includes("@") ? request.handle : contact.found && contact.matches === 1 ? contact.emails[0] : undefined;
  request = (await write(request, { action: "book", start: offer.start, attendees: email })).request;
  return { ...view(request, config), invitationSent: !!email, overlappedWithOwnerApproval: checked.overlap };
}

async function otherTimes(request: Request, config: Config, args: GuestArgs, sendOwner?: SendOwner) {
  const preferred = preferences(args, config.timezone);
  const excludedDays = preferences({ days: args.excludedDays }, config.timezone).days ?? [];
  const availableDays = { days: DAYS.filter(day => !excludedDays.includes(day)) };
  const bounds = intersectConstraints(request.constraints, availableDays);
  const start = args.start;
  let exact: Slot | undefined;
  if (start) {
    const checked = await check(request, config, start);
    if (!withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, availableDays)) {
      return { error: "That weekday was ruled out. Choose a different day." };
    }
    if (checked.free && checked.outsideHours) return askOwner(request, config, { start }, sendOwner);
    if (checked.free && withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) exact = checked.slot;
    preferred.from = preferred.to = checked.slot.start.slice(0, 10);
    preferred.after = checked.slot.start.slice(11, 16);
    preferred.before = checked.slot.end.slice(11, 16);
  }
  const now = Date.now();
  const busy = await busyFor(request, config, localIso(now, config.timezone), localIso(now + (config.horizonDays + 1) * 86_400_000, config.timezone));
  const narrowed = intersectConstraints(bounds, preferred);
  const query: SlotQuery = { ...busy, ...narrowed, days: narrowed.days as Day[] | undefined, now, config,
    meal: request.meal, durationMin: request.durationMin, allowOverlap: request.allowOverlap, locale: request.locale, exclude: [...currentOffers(request).map(o => o.start), ...(request.booked ? [request.booked.start] : [])] };
  let { slots } = exact ? { slots: [exact] } : findSlots(query);
  const preferencesUnavailable = slots.length === 0;
  if (preferencesUnavailable) {
    const fallback = { ...query, ...bounds, days: bounds.days as Day[] };
    if (preferred.from && preferred.to && preferred.from < preferred.to) {
      slots = findSlots({ ...fallback, from: narrowed.from, to: narrowed.to }).slots;
    }
    if (!slots.length) slots = findSlots(fallback).slots;
  }
  if (!slots.length) return { error: "No new times are available within the owner's conditions. The current offer is unchanged." };
  const { origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, constraints, proposed, allowOverlap, format, locale } = request;
  request = (await write(request, { action: "offer", request: {
    origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, constraints, proposed, allowOverlap, format, locale,
    offered: slots.map(slot => ({ start: slot.start, end: slot.end, account: config.defaultAccount })),
  } })).request;
  return { ...view(request, config), preferencesUnavailable };
}

async function askOwner(request: Request, config: Config, args: GuestArgs, sendOwner?: SendOwner) {
  args = { ...args,
    start: typeof args.start === "string" ? args.start.trim() || undefined : args.start,
    question: typeof args.question === "string" ? args.question.trim() || undefined : args.question,
  };
  if (request.pendingOwner) return { error: "A question is already open with the owner. Wait for their answer." };
  if ((args.question === undefined) === (args.start === undefined)) return { error: "Provide either a question or a start time, not both." };
  if (!sendOwner) return { error: "Owner messaging is unavailable. Nothing was sent." };
  let pendingOwner: PendingOwner;
  let question: string;
  const askedAt = new Date(Date.now()).toISOString();
  if (args.question !== undefined) {
    if (typeof args.question !== "string" || !args.question.trim()) return { error: "Provide a question about this meeting." };
    question = args.question.replace(/\s+/g, " ").trim();
    const closingQuote: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
    while (question.length >= 2 && closingQuote[question[0]!] === question.at(-1)) question = question.slice(1, -1).trim();
    if (!question) return { error: "Provide a question about this meeting." };
    question = question.slice(0, OWNER_QUESTION_LIMIT);
    pendingOwner = { question, askedAt };
  } else {
    const checked = await check(request, config, args.start!);
    if (!checked.free) return { error: "That time is not available. Offer the current times or ask for other times." };
    if (!checked.outsideHours) return { error: "That time is within the meeting window. Ask for other times to get an offer." };
    pendingOwner = { start: checked.slot.start, end: checked.slot.end, askedAt };
    question = `Can we meet ${localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(checked.slot.start))} (${config.timezone}), outside the meeting window?`;
  }
  // Save the question and its notification together so the poll cannot send a
  // second owner ask while this DM is in flight or its delivery is uncertain.
  updateJson<Ledger>(file("ledger.json"), EMPTY, ledger => {
    unchanged(request, ledger.requests.find(r => r.id === request.id)!);
    const next = updateRequest(ledger, request.id, { pendingOwner }, Date.now());
    return { requests: next.requests.map(r => r.id === request.id ? { ...r, lastNudge: {
      fingerprint: nudgeFingerprint("question" in pendingOwner ? "owner-question" : "time-approval", pendingOwner.askedAt),
      at: new Date(Date.now()).toISOString(),
    } } : r) };
  });
  // Keep the slot on an uncertain send so another turn cannot duplicate it.
  try {
    const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
    await sendOwner("question" in pendingOwner
      ? `${label(request.name ?? "Your guest")} asked in your ${label(meetingTopic(request))} thread: '${question}'. Reply there, or tell me what to say.`
      : `${label(request.name ?? "Your guest")} in your ${label(meetingTopic(request))} group asks: ${JSON.stringify(question)} — what should I tell them?`);
  } catch {
    return { error: "I could not confirm delivery to the owner. The question remains pending; do not send it again." };
  }
  return { ownerName: config.ownerName, ownerAskSent: true,
    ...("question" in pendingOwner ? { silent: true } : { message: `I've asked ${config.ownerName} and will get back to you here when they reply.` }) };
}

export async function guestAction(ctx: GuestContext, action: GuestAction, args: GuestArgs = {}, sendOwner?: SendOwner): Promise<object> {
  try {
    let request = current(readJson<Ledger>(file("ledger.json"), EMPTY), ctx);
    if (!request) return { error: "No scheduling request matches you in this conversation." };
    const config = loadConfig();
    if (action === "view") return view(request, config);
    if (config.paused) return { error: "Scheduling is paused. The owner can resume it." };
    if (action === "format") {
      if (request.status !== "offered" && request.status !== "booked") return view(request, config);
      if (!["meet", "in_person", "phone", "unknown"].includes(args.format ?? "")) return { error: "Choose meet, in_person, phone, or unknown." };
      if (args.location !== undefined && (typeof args.location !== "string" || args.location.length > 1000)) return { error: "Provide a short meeting place." };
      const change = { format: args.format!, location: args.location ?? "" };
      request = (await write(request, { action: "format", ...change })).request;
      return view(request, config);
    }
    if (action === "ask_owner" && (request.status === "offered" || (request.status === "booked" && typeof args.question === "string" && args.question.trim()))) {
      const result = await askOwner(request, config, args, sendOwner);
      return typeof args.question === "string" && args.question.trim() ? { ...result, silent: true } : result;
    }
    if (request.status !== "offered" && request.status !== "booked") return view(request, config);
    if (action === "decline") {
      const booked = request.status === "booked";
      request = (await write(request, { action: request.status === "booked" ? "cancel" : "drop" })).request;
      return { ...view(request, config), ...(booked ? await notifyOwner(request, config, "cancelled", sendOwner) : {}) };
    }
    if (action === "other_times") return await otherTimes(request, config, args, sendOwner);
    if (!args.start) return { error: "Provide a start time." };
    return await pick(request, config, args.start, sendOwner);
  } catch {
    // Backend output can contain private event details, contact data, and accounts.
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
