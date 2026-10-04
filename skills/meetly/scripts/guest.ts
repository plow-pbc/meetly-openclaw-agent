// Scheduling actions scoped to the sender and conversation supplied by OpenClaw.
import { allowsOverlap, fetchBusy, type BusyResult } from "./busy.ts";
import { loadConfig, parseTime, type Config } from "./config.ts";
import { lookupContact } from "./contact.ts";
import { calendarAction, type CalendarAction } from "./calendar.ts";
import { findByChat, intersectConstraints, sameHandle, OWNER_QUESTION_LIMIT, updateRequest, type Constraints, type Format, type HoldRef, type Ledger, type Patch, type PendingOwner, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { checkTime, findPreferredSlots, preferredSearchCoverage, localeFormatter, withinConstraints, type Slot, type SlotQuery } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";
import { DAYS, localIso, nextWeek, offerDateWindow, resolveWeekday, WeekdayDateRequired, type WeekdayTime } from "./time.ts";
import { view } from "./request-view.ts";

export type GuestContext = { messageChannel?: string; agentAccountId?: string; nativeChannelId?: string; deliveryContext?: { to?: string }; requesterSenderId?: string };
export type GuestAction = "view" | "pick" | "other_times" | "format" | "ask_owner" | "decline";
export type GuestArgs = Constraints & { excludedDays?: string[]; restoredDays?: string[]; offer_week?: boolean; next_week?: string; start?: string | WeekdayTime; question?: string; format?: Format; location?: string };
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

const holds = (request: Request): HoldRef[] => request.offered.flatMap(o => o.holdId ? [{ holdId: o.holdId, account: o.account }] : []);
// Recheck the guest's authorized snapshot inside the writer lock. A concurrent
// booking or replacement must not turn a guest pick into an owner-style move.
function unchanged(request: Request, latest: Request): void {
  // Reserving a format question changes delivery metadata, not scheduling authority.
  const snapshot = ({ detailsAskedAt: _details, updatedAt: _updated, ...state }: Request) => state;
  if (!latest || JSON.stringify(snapshot(request)) !== JSON.stringify(snapshot(latest))) throw new Error("request changed");
}

const write = (request: Request, action: CalendarAction) => calendarAction(request.id, action, {
  validate: latest => unchanged(request, latest),
});

// Remove only this request's own holds, including their account, from busy time.
async function busyFor(request: Request, config: Config, from: string, to: string): Promise<BusyResult> {
  const result = await fetchBusy(config, { from, to });
  if (result.degraded.length) throw new Error("calendar unavailable");
  return { ...result, busy: result.busy.filter(b => !holds(request).some(h => h.holdId === b.id && h.account === b.account)) };
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

async function check(request: Request, config: Config, requested: string | WeekdayTime) {
  if (typeof requested === "object" && requested.time === undefined) throw new Error("An exact time is required");
  const start = typeof requested === "string" ? requested : resolveWeekday(requested, request.offered, config.timezone);
  const query = { now: Date.now(), config, meal: request.meal, ownerStartTime: request.constraints?.startTime, durationMin: request.durationMin, start, locale: request.locale, allowOverlap: request.allowOverlap };
  const { slot } = checkTime({ ...query, busy: [] });
  const busy = await busyFor(request, config, slot.start, slot.end);
  const checked = checkTime({ ...query, ...busy });
  const overlap = busy.busy.some(b => allowsOverlap(b, request.allowOverlap)
    && Date.parse(b.start) < Date.parse(slot.end) && Date.parse(b.end) > Date.parse(slot.start));
  return { ...checked, overlap };
}

async function pick(request: Request, config: Config, start: string) {
  const requested = checkTime({ now: Date.now(), config, busy: [], start,
    meal: request.meal, ownerStartTime: request.constraints?.startTime, durationMin: request.durationMin }).slot.start;
  const offer = request.offered.find(o => Date.parse(o.start) === Date.parse(requested));
  if (!offer) return { error: "Choose one of the currently offered start times." };
  const checked = await check(request, config, offer.start);
  if (!checked.free || checked.outsideHours || !withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) return { error: "That time is no longer available. Ask for other times." };
  const contact = await lookupContact(request.handle);
  const email = request.handle.includes("@") ? request.handle : contact.found && contact.matches === 1 ? contact.emails[0] : undefined;
  request = (await write(request, { action: "book", start: offer.start, attendees: email })).request;
  return { ...view(request, config), invitationSent: !!email, overlappedWithOwnerApproval: checked.overlap };
}

// Tool arguments may encode a weekday object as JSON inside a string.
function otherTimesStart(start: GuestArgs["start"]): GuestArgs["start"] {
  if (typeof start === "string") {
    const text = start.trim();
    if (/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i.test(text)) {
      return { weekday: text.slice(0, 3).toLowerCase() as WeekdayTime["weekday"] };
    }
    if (text.startsWith("{")) start = JSON.parse(text);
  }
  if (start && typeof start === "object" && typeof start.time === "string" && !start.time.trim()) {
    return { ...start, time: undefined };
  }
  return start;
}

async function otherTimes(request: Request, config: Config, args: GuestArgs, sendOwner?: SendOwner) {
  if (typeof args.offer_week !== "boolean") {
    const message = "Set offer_week explicitly: true for that week or the same week; false when the guest asks for a new date range or a broader search. Include every named unavailable weekday in excludedDays. No search or holds were made; retry with this scope.";
    return { error: message, code: "DATE_SCOPE_REQUIRED", recovery: { action: "retry", retry: true, message } };
  }
  if (args.offer_week && args.next_week !== undefined) {
    const message = "For that week, keep offer_week: true and omit next_week entirely. Retain excludedDays and any preferred weekday. next_week is only for a new week relative to a source timestamp, with offer_week: false. No search or holds were made; retry using only the intended scope.";
    return { error: message, code: "DATE_SCOPE_CONFLICT", recovery: { action: "retry", retry: true, message } };
  }
  args = { ...args, start: otherTimesStart(args.start) };
  const preferred = preferences(args, config.timezone);
  const newlyExcluded = preferences({ days: args.excludedDays }, config.timezone).days ?? [];
  const restored = preferences({ days: args.restoredDays }, config.timezone).days ?? [];
  if (newlyExcluded.some(day => restored.includes(day))) throw new Error("a weekday cannot be both excluded and restored");
  const excludedDays = [...new Set([...(request.excludedDays ?? []).filter(day => !restored.includes(day)), ...newlyExcluded])];
  const availableDays = { days: DAYS.filter(day => !excludedDays.includes(day)) };
  const relative = args.offer_week === true || typeof args.start === "object" || (!args.start && args.days?.length && !args.from && !args.to && !args.next_week);
  const window = relative ? offerDateWindow(request.offered, config.timezone) : undefined;
  const bounds = intersectConstraints(intersectConstraints(request.constraints, window), availableDays);
  if (args.excludedDays !== undefined || args.restoredDays !== undefined) request = patch(request, { excludedDays });
  let start = args.start;
  if (typeof start === "object" && !start.time?.trim()) {
    preferred.from = preferred.to = resolveWeekday({ weekday: start.weekday }, request.offered, config.timezone);
    start = undefined;
  }
  let exact: Slot | undefined;
  if (start) {
    const checked = await check(request, config, start);
    if (!withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, availableDays)) {
      return { error: "That weekday was ruled out. Choose a different day." };
    }
    const { days, from, to } = bounds;
    const allowedDay = withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, { days, from, to });
    if (allowedDay && checked.free && checked.outsideHours) return askOwner(request, config, { start: checked.slot.start }, sendOwner);
    if (checked.free && withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) exact = checked.slot;
    preferred.from = preferred.to = checked.slot.start.slice(0, 10);
    preferred.after = checked.slot.start.slice(11, 16);
    preferred.before = checked.slot.end.slice(11, 16);
  }
  const now = Date.now();
  const query: SlotQuery = { busy: [], ...bounds, now, config,
    meal: request.meal, ownerStartTime: request.constraints?.startTime, durationMin: request.durationMin, allowOverlap: request.allowOverlap, locale: request.locale, exclude: request.offered.map(o => o.start) };
  const range = preferredSearchCoverage(query, preferred);
  Object.assign(query, await busyFor(request, config, range.from, range.to));
  const narrowed = intersectConstraints(bounds, preferred);
  const fallbacks = preferred.from && preferred.to && preferred.from < preferred.to
    ? [{ ...query, from: narrowed.from, to: narrowed.to }, query] : [query];
  const { slots, preferencesUnavailable, incomplete } = exact ? { slots: [exact], preferencesUnavailable: false, incomplete: undefined } : findPreferredSlots(query, preferred, fallbacks);
  if (incomplete) return { error: "Calendar data is incomplete for the requested dates. Availability is not yet known; the current offer is unchanged.", code: "INCOMPLETE_CALENDAR", incomplete };
  if (!slots.length) return { error: "No other times are available within the owner's conditions. The current offer is unchanged." };
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
    question = args.question.replace(/\s+/g, " ").trim().slice(0, OWNER_QUESTION_LIMIT);
    pendingOwner = { question, askedAt };
  } else {
    const checked = await check(request, config, args.start!);
    if (!withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) {
      return { error: "That time is outside the owner's conditions. Choose another time from the current offer." };
    }
    if (!checked.free) return { error: "That time is not available. Offer the current times or ask for other times." };
    if (!checked.outsideHours) return { error: "That time is within the meeting window. Ask for other times to get an offer." };
    pendingOwner = { start: checked.slot.start, end: checked.slot.end, askedAt };
    question = `Can we meet ${localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(checked.slot.start))} (${config.timezone}), outside the meeting window?`;
  }
  patch(request, { pendingOwner });
  // Keep the slot on an uncertain send so another turn cannot duplicate it.
  try {
    const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
    await sendOwner(`${label(request.name ?? "Your guest")} in your ${label(request.topic)} group asks: ${JSON.stringify(question)} — what should I tell them?`);
  } catch {
    return { error: "I could not confirm delivery to the owner. The question remains pending; do not send it again." };
  }
  return { ownerName: config.ownerName, ownerAskSent: true, askDetails: false, message: `I've asked ${config.ownerName} and will get back to you here when ${config.ownerName} replies.` };
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
    if (action === "ask_owner" && ["offered", "booked"].includes(request.status)) {
      if (typeof args.question !== "string" || !args.question.trim()) return { error: "Provide a question about this meeting." };
      return await askOwner(request, config, { question: args.question }, sendOwner);
    }
    if (request.status !== "offered") return { ...view(request, config), message: "Changes to closed requests must go through the owner in this conversation." };
    if (action === "decline") {
      request = (await write(request, { action: "drop" })).request;
      return { ...view(request, config), message: "I've cancelled this scheduling request." };
    }
    if (action === "other_times") return await otherTimes(request, config, args, sendOwner);
    if (typeof args.start !== "string" || !args.start) return { error: "Provide an offered start time." };
    return await pick(request, config, args.start);
  } catch (error) {
    if (error instanceof WeekdayDateRequired) return { error: error.message, code: "DATE_REQUIRED",
      recovery: { action: "ask_date", retry: false } };
    const message = error instanceof Error ? error.message : "";
    const code = message === "request changed" ? "REQUEST_CHANGED"
      : message === "calendar unavailable" ? "CALENDAR_UNAVAILABLE"
      : /calendar (?:operation|write) unresolved/.test(message) ? "CALENDAR_WRITE_PENDING" : "SCHEDULING_FAILED";
    // Keep the exception in local diagnostics; never relay backend details to guests.
    console.error(`meetly guest ${action} failed (${code}):`, error);
    // Backend output can contain private event details, contact data, and accounts.
    return { error: "The scheduling action could not be completed.", code,
      recovery: code === "REQUEST_CHANGED" ? { action: "view_request", tool: "meetly_view_request", retry: false }
        : { action: "reply", retry: false, message: code === "CALENDAR_WRITE_PENDING"
          ? "The calendar update is still pending. Please wait for confirmation."
          : "I couldn't update the meeting times. Please try again later." } };
  }
}
