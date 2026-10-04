// Scheduling actions scoped to the sender and conversation supplied by OpenClaw.
import { checkTravel, TravelBaseRequired, travelNote, travelRange, type Travel } from "./travel.ts";
import { allowsOverlap, fetchBusy, type BusyResult } from "./busy.ts";
import { loadConfig, parseTime, type Config } from "./config.ts";
import { lookupContact } from "./contact.ts";
import { calendarAction, type CalendarAction } from "./calendar.ts";
import { nudgeFingerprint, sameRequest, currentOffers, requestEvents, findByChat, meetingTopic, intersectConstraints, sameHandle, OWNER_QUESTION_LIMIT, updateRequest, type Constraints, type Format, type HoldRef, type Ledger, type Patch, type PendingOwner, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { checkTime, findPreferredSlots, localeFormatter, withinConstraints, type Slot, type SlotQuery } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";
import { DAYS, localIso, nextWeek, offerDateWindow, resolveWeekday, WeekdayDateRequired, wallParts, type WeekdayTime } from "./time.ts";
import { view } from "./request-view.ts";
import { plowApi } from "./owner-chat.ts";

export type GuestContext = { turnStartedAt?: number; messageChannel?: string; agentAccountId?: string; nativeChannelId?: string; deliveryContext?: { to?: string }; requesterSenderId?: string; senderIsOwner?: boolean;
  config?: { channels?: { plow?: { apiBase?: string; emailLineUid?: string } } } };
export type GuestAction = "view" | "pick" | "other_times" | "format" | "ask_owner" | "decline";
export type GuestArgs = Constraints & { excludedDays?: string[]; next_week?: string; start?: string | WeekdayTime; question?: string; format?: Format; location?: string; attendees?: string[]; travel?: Travel };
type SendOwner = (text: string) => Promise<void>;
const EMPTY: Ledger = { requests: [] };

const chatId = (ctx: GuestContext) => ctx.nativeChannelId ?? ctx.deliveryContext?.to?.replace(/^plow:/, "");

function current(ledger: Ledger, ctx: GuestContext): Request | undefined {
  const chat = chatId(ctx);
  const sender = ctx.requesterSenderId;
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || !chat || !sender) return;
  const texts = { requests: ledger.requests.filter(r => r.channel === "text") };
  const request = findByChat(texts, chat);
  return request && sameHandle(request.handle, sender) ? request : undefined;
}

async function resolveRequest(ctx: GuestContext): Promise<Request | undefined> {
  if (ctx.messageChannel === "plow" && ctx.agentAccountId === "email" && chatId(ctx) && ctx.requesterSenderId && ctx.senderIsOwner !== true) {
    const chat = chatId(ctx)!;
    const emails = (ledger: Ledger) => ({ requests: ledger.requests.filter(r => r.channel === "email") });
    const linked = findByChat(emails(readJson<Ledger>(file("ledger.json"), EMPTY)), chat);
    if (linked) return linked;
    // Recover an uncertain opener using the server's thread roster, never tool arguments.
    const account = ctx.config?.channels?.plow;
    if (!account?.emailLineUid) return;
    const api = plowApi({ base: account.apiBase });
    const response = await api.fetch(`${api.base}/v1/chats/${encodeURIComponent(chat)}`, {
      headers: api.headers, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("email thread unavailable");
    const thread = await response.json() as { uid: string; status: string; participants: { type: string; relationship?: string; line?: { uid?: string }; provider_key?: string }[] };
    if (thread.uid !== chat || thread.status !== "active" || !thread.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line?.uid === account.emailLineUid)) return;
    const handles = thread.participants.filter(p => p.type === "member").map(p => p.provider_key ?? "");
    if (!handles.some(handle => sameHandle(handle, ctx.requesterSenderId!))) return;
    let id: string | undefined;
    const ledger = updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
      const existing = findByChat(emails(l), chat);
      if (existing) { id = existing.id; return l; }
      const candidates = emails(l).requests.filter(r => r.status === "offered" && !r.chatUid && r.startedAt && handles.some(handle => sameHandle(handle, r.handle)));
      if (candidates.length !== 1) return l;
      id = candidates[0]!.id;
      return updateRequest(l, id, { chatUid: chat }, Date.now());
    });
    return ledger.requests.find(r => r.id === id);
  }
  return current(readJson<Ledger>(file("ledger.json"), EMPTY), ctx);
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

// Remove this request's holds, booking and travel, with their accounts.
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

async function check(request: Request, config: Config, requested: string | WeekdayTime) {
  if (typeof requested === "object" && requested.time === undefined) throw new Error("An exact time is required");
  const start = typeof requested === "string" ? requested : resolveWeekday(requested, request.reoffer?.offered ?? request.offered, config.timezone);
  const query = { now: Date.now(), config, travel: request.travel, format: request.format, meal: request.meal, durationMin: request.durationMin, start, locale: request.locale, allowOverlap: request.allowOverlap };
  const { slot } = checkTime({ ...query, busy: [] });
  const range = travelRange(slot.start, slot.end, request);
  const busy = await busyFor(request, config, range.from, range.to);
  const checked = checkTime({ ...query, ...busy });
  const overlap = busy.busy.some(b => allowsOverlap(b, request.allowOverlap)
    && Date.parse(b.start) < Date.parse(range.to) && Date.parse(b.end) > Date.parse(range.from));
  return { ...checked, overlap };
}

async function notifyOwner(request: Request, config: Config, change: "moved" | "cancelled" | "travel", sendOwner?: SendOwner, note = travelNote(request)) {
  const when = localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(request.booked!.start));
  const subject = `${meetingTopic(request)} with ${request.name ?? request.handle}`;
  if (change === "travel" && !note) return {};
  const text = change === "travel" ? note! : change === "moved" ? `${subject} moved to ${when} (${config.timezone}).${note ? ` ${note}` : ""}`
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

async function pick(request: Request, config: Config, start: string, attendees?: string[], sendOwner?: SendOwner, turnStartedAt?: number, travel?: Travel) {
  if (attendees !== undefined && (!Array.isArray(attendees) || (attendees.length > 0 && (request.channel !== "email" || request.status === "booked"
    || attendees.some(email => typeof email !== "string" || !/^[^\s@,]+@[^\s@,]+$/.test(email)))))) return { error: "Additional invitees need email addresses on an unbooked email request." };
  const requested = checkTime({ now: Date.now(), config, busy: [], start,
    travel: { beforeMin: 0, afterMin: 0 }, meal: request.meal, durationMin: request.durationMin }).slot.start;
  const offer = currentOffers(request).find(o => Date.parse(o.start) === Date.parse(requested));
  if (!offer) return { error: "Choose one of the currently offered start times." };
  // Only a replacement held before this run can represent the guest's choice.
  if (request.status === "booked" && !(Number.isFinite(turnStartedAt)
    && Date.parse(request.reoffer!.offeredAt) < turnStartedAt!)) {
    return { error: "Present the replacement times and wait for the guest to choose in a later turn. The booking is unchanged." };
  }
  const checked = await check({ ...request, travel: request.travel?.override ? request.travel : travel ?? request.travel }, config, offer.start);
  if (!checked.free || checked.outsideHours || !withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) return { error: "That time is no longer available.", code: "TIME_UNAVAILABLE",
    recovery: { action: "other_times", tool: "meetly_other_times", retry: false } };
  if (request.status === "booked") {
    const result = await write(request, { action: "book", start: offer.start, end: offer.end, travel });
    request = result.request;
    return { ...view(request, config), invitationUpdated: "invitationUpdated" in result && result.invitationUpdated === true,
      overlappedWithOwnerApproval: checked.overlap, ...await notifyOwner(request, config, "moved", sendOwner) };
  }
  const contact = request.handle.includes("@") ? undefined : await lookupContact(request.handle);
  const email = request.handle.includes("@") ? request.handle : contact?.found && contact.matches === 1 ? contact.emails[0] : undefined;
  request = (await write(request, { action: "book", start: offer.start, travel, attendees: [email, ...attendees ?? []].filter(Boolean).join(",") || undefined })).request;
  return { ...view(request, config), invitationSent: !!email, overlappedWithOwnerApproval: checked.overlap,
    ...await notifyOwner(request, config, "travel", sendOwner) };
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
  const travel = request.travel?.override ? request.travel : args.travel ?? request.travel;
  try {
    args = { ...args, start: otherTimesStart(args.start) };
    if (args.start !== undefined && typeof args.start !== "string") {
      resolveWeekday(args.start!, request.reoffer?.offered ?? request.offered, config.timezone);
    }
  } catch (error) {
    if (error instanceof WeekdayDateRequired) throw error;
    return { error: "Provide a valid weekday (mon–sun) and time (HH:MM), or an explicit calendar date and time." };
  }
  const preferred = preferences(args, config.timezone);
  const excludedDays = preferences({ days: args.excludedDays }, config.timezone).days ?? [];
  const availableDays = { days: DAYS.filter(day => !excludedDays.includes(day)) };
  const relative = typeof args.start === "object" || (!args.start && args.days?.length && !args.from && !args.to && !args.next_week);
  const window = relative ? offerDateWindow(request.reoffer?.offered ?? request.offered, config.timezone) : undefined;
  const bounds = intersectConstraints(intersectConstraints(request.constraints, window), availableDays);
  let start = args.start;
  if (typeof start === "object" && !start.time?.trim()) {
    preferred.from = preferred.to = resolveWeekday({ weekday: start.weekday }, request.reoffer?.offered ?? request.offered, config.timezone);
    start = undefined;
  }
  const bookedDate = request.status === "booked" && request.booked
    ? localIso(Date.parse(request.booked.start), config.timezone).slice(0, 10) : undefined;
  let requestedBookedDate = bookedDate !== undefined && (preferred.from === preferred.to && preferred.from === bookedDate
    || args.days?.length === 1 && args.days[0] === wallParts(Date.parse(request.booked!.start), config.timezone).weekday);
  let exact: Slot | undefined;
  if (start) {
    const checked = await check({ ...request, travel }, config, start);
    requestedBookedDate = checked.slot.start.slice(0, 10) === bookedDate;
    if (!withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, availableDays)) {
      return { error: "That weekday was ruled out. Choose a different day." };
    }
    const { days, from, to } = request.constraints ?? {};
    const allowedDay = withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, { days, from, to });
    if (allowedDay && checked.free && checked.outsideHours) return askOwner(request, config, { start: checked.slot.start }, sendOwner);
    if (checked.free && withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) exact = checked.slot;
    preferred.from = preferred.to = checked.slot.start.slice(0, 10);
    preferred.after = checked.slot.start.slice(11, 16);
    preferred.before = checked.slot.end.slice(11, 16);
  }
  const now = Date.now();
  const busy = await busyFor(request, config, localIso(now, config.timezone), localIso(now + (config.horizonDays + 1) * 86_400_000, config.timezone));
  const query: SlotQuery = { ...busy, ...bounds, now, config, travel, format: request.format,
    excludeDates: bookedDate && !requestedBookedDate ? [bookedDate] : [],
    meal: request.meal, durationMin: request.durationMin, allowOverlap: request.allowOverlap, locale: request.locale, exclude: [...currentOffers(request).map(o => o.start), ...(request.booked ? [request.booked.start] : [])] };
  const narrowed = intersectConstraints(bounds, preferred);
  const fallbacks = preferred.from && preferred.to && preferred.from < preferred.to
    ? [{ ...query, from: narrowed.from, to: narrowed.to }, query] : [query];
  const { slots, preferencesUnavailable } = exact ? { slots: [exact], preferencesUnavailable: false } : findPreferredSlots(query, preferred, fallbacks);
  if (!slots.length) return { error: "No other times are available within the owner's conditions. The current offer is unchanged.",
    code: "NO_ALTERNATIVES", conditions: request.constraints ?? {},
    recovery: { action: "ask_owner", tool: "meetly_ask_owner", retry: false,
      question: "No alternative times fit the meeting conditions. May we look on another day or widen the time window?" } };
  const { channel, origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, constraints, proposed, allowOverlap, format, locale } = request;
  request = (await write(request, { action: "offer", request: {
    channel, travel, origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, constraints, proposed, allowOverlap, format, locale,
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
  if (request.channel !== "email" && !sendOwner) return { error: "Owner messaging is unavailable. Nothing was sent." };
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
    if (!withinConstraints(Date.parse(checked.slot.start), Date.parse(checked.slot.end), config.timezone, request.constraints)) {
      return { error: "That time is outside the owner's conditions. Choose another time from the current offer." };
    }
    if (!checked.free) return { error: "That time is not available. Offer the current times or ask for other times." };
    if (!checked.outsideHours) return { error: "That time is within the meeting window. Ask for other times to get an offer." };
    pendingOwner = { start: checked.slot.start, end: checked.slot.end, askedAt };
    question = `Can we meet ${localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(checked.slot.start))} (${config.timezone}), outside the meeting window?`;
  }
  // Save the question and its notification together so the poll cannot send a
  // second owner ask while the notification is in flight or its delivery is uncertain.
  updateJson<Ledger>(file("ledger.json"), EMPTY, ledger => {
    unchanged(request, ledger.requests.find(r => r.id === request.id)!);
    const next = updateRequest(ledger, request.id, { pendingOwner }, Date.now());
    return { requests: next.requests.map(r => r.id === request.id ? { ...r, lastNudge: {
      fingerprint: nudgeFingerprint("question" in pendingOwner ? "owner-question" : "time-approval", pendingOwner.askedAt),
      at: new Date(Date.now()).toISOString(),
    } } : r) };
  });
  if (request.channel === "email") return { ownerQuestion: question, guestName: request.name, topic: meetingTopic(request),
    replyToOwner: true, message: "Ask the owner in your final text. Do not send an email to the thread or send a separate DM." };
  // Keep the slot on an uncertain send so another turn cannot duplicate it.
  try {
    const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
    await sendOwner!("question" in pendingOwner
      ? `${label(request.name ?? "Your guest")} asked in your ${label(meetingTopic(request))} thread. Guest question: ${JSON.stringify(question)}. Reply there, or tell me what to say.`
      : `${label(request.name ?? "Your guest")} in your ${label(meetingTopic(request))} group asks: ${JSON.stringify(question)} — what should I tell them?`);
  } catch {
    return { error: "I could not confirm delivery to the owner. The question remains pending; do not send it again." };
  }
  return { ownerName: config.ownerName, ownerAskSent: true, askDetails: false,
    ...("question" in pendingOwner ? { silent: true } : { message: `I've asked ${config.ownerName} and will get back to you here when ${config.ownerName} replies.` }) };
}

export async function guestAction(ctx: GuestContext, action: GuestAction, args: GuestArgs = {}, sendOwner?: SendOwner): Promise<object> {
  try {
    let request = await resolveRequest(ctx);
    const config = loadConfig();
    if (!request) return { ownerName: config.ownerName, error: `${config.ownerName} will confirm.` };
    if (args.travel !== undefined) {
      checkTravel(args.travel);
      args = { ...args, travel: { beforeMin: args.travel.beforeMin, afterMin: args.travel.afterMin } };
    }
    if (action === "view") return view(request, config);
    if (config.paused) return { error: "Scheduling is paused. The owner can resume it." };
    if (action === "format") {
      if (request.status !== "offered" && request.status !== "booked") return view(request, config);
      if (!["meet", "in_person", "phone", "unknown"].includes(args.format ?? "")) return { error: "Choose meet, in_person, phone, or unknown." };
      if (args.location !== undefined && (typeof args.location !== "string" || args.location.length > 1000)) return { error: "Provide a short meeting place." };
      const change = { format: args.format!, location: args.location ?? "", travel: args.travel };
      const result = await write(request, { action: "format", ...change });
      request = result.request;
      return { ...view(request, config), ...(request.status === "booked" ? await notifyOwner(request, config, "travel", sendOwner, "ownerTravelNote" in result ? result.ownerTravelNote : undefined) : {}) };
    }
    if (action === "ask_owner" && ["offered", "booked"].includes(request.status)) {
      if (typeof args.question !== "string" || !args.question.trim()) return { error: "Provide a question about this meeting." };
      const result = await askOwner(request, config, { question: args.question }, sendOwner);
      return request.channel !== "email" ? { ...result, silent: true } : result;
    }
    if (request.status !== "offered" && request.status !== "booked") return view(request, config);
    if (action === "decline") {
      const booked = request.status === "booked";
      request = (await write(request, { action: request.status === "booked" ? "cancel" : "drop" })).request;
      return { ...view(request, config), ...(booked ? await notifyOwner(request, config, "cancelled", sendOwner) : { message: "I've cancelled this scheduling request." }) };
    }
    if (action === "other_times") return await otherTimes(request, config, args, sendOwner);
    if (typeof args.start !== "string" || !args.start) return { error: "Provide an offered start time." };
    if (action === "pick") return await pick(request, config, args.start, args.attendees, sendOwner, ctx.turnStartedAt, args.travel);
    return { error: "Unknown scheduling action." };
  } catch (error) {
    if (error instanceof TravelBaseRequired) return { error: "The owner needs to provide travel information privately before scheduling can continue.",
      code: "TRAVEL_BASE_REQUIRED", recovery: { action: "ask_owner", tool: "meetly_ask_owner", retry: false,
        question: "What home or office base should I use to estimate travel? Please reply in your private DM." } };
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
