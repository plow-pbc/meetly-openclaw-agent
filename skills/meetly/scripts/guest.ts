// Scheduling actions scoped to the sender and conversation supplied by OpenClaw.
import { fetchBusy, type BusyResult } from "./busy.ts";
import { loadConfig, parseTime, type Config, type Day } from "./config.ts";
import { lookupContact } from "./contact.ts";
import { parseEvent, type EventInfo } from "./event.ts";
import { findByChat, findOpenByHandle, OWNER_QUESTION_LIMIT, sameHandle, updateRequest, type Constraints, type Format, type HoldRef, type Ledger, type Offer, type Patch, type PendingOwner, type Request } from "./ledger.ts";
import { runOnMac } from "./mac.ts";
import { file } from "./paths.ts";
import { recordBooking } from "./record-booking.ts";
import { checkTime, findSlots, localeFormatter, type SlotQuery } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";
import { DAYS, localIso, wallParts } from "./time.ts";

export type GuestContext = { messageChannel?: string; agentAccountId?: string; nativeChannelId?: string; deliveryContext?: { to?: string }; requesterSenderId?: string };
export type GuestAction = "view" | "pick" | "other_times" | "format" | "ask_owner" | "decline";
export type GuestArgs = Constraints & { start?: string; question?: string; format?: Format; location?: string };
type SendOwner = (text: string) => Promise<void>;
const EMPTY: Ledger = { requests: [] };

function current(ledger: Ledger, ctx: GuestContext): Request | undefined {
  const chat = (ctx.nativeChannelId ?? ctx.deliveryContext?.to)?.replace(/^plow:/i, "");
  const sender = ctx.requesterSenderId;
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || !chat || !sender) return;
  const linked = findByChat(ledger, chat);
  const open = findOpenByHandle(ledger, sender, ["offered"]);
  if (open && ((open.chatUid && open.chatUid !== chat) || (linked?.status === "offered" && linked.id !== open.id))) return;
  const request = open ?? linked;
  return request && sameHandle(request.handle, sender) && request.status !== "asked" ? request : undefined;
}

function resolveRequest(ctx: GuestContext): Request | undefined {
  const request = current(readJson<Ledger>(file("ledger.json"), EMPTY), ctx);
  if (!request || request.chatUid) return request;
  const ledger = updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
    const latest = current(l, ctx);
    if (!latest || latest.id !== request.id) throw new Error("request changed");
    return updateRequest(l, latest.id, { chatUid: (ctx.nativeChannelId ?? ctx.deliveryContext!.to!).replace(/^plow:/i, "") }, Date.now());
  });
  return ledger.requests.find(r => r.id === request.id);
}

function patch(request: Request, change: Patch): Request {
  return updateJson<Ledger>(file("ledger.json"), EMPTY, l => updateRequest(l, request.id, change, Date.now()))
    .requests.find(r => r.id === request.id)!;
}

function view(request: Request, config: Config) {
  const format = localeFormatter(request.locale ?? "en-US", config.timezone);
  const time = (slot: { start: string; end: string }) => ({ start: slot.start, end: slot.end, label: format.format(new Date(slot.start)) });
  return {
    status: request.status, ownerName: config.ownerName, timezone: config.timezone,
    topic: request.topic, durationMin: request.durationMin, format: request.format ?? "unknown", location: request.location,
    offered: request.status === "offered" ? request.offered.map(time) : [],
    ...(request.booked ? { booked: time(request.booked), reminderAvailable: !!request.meetUrl } : {}),
    ...(request.pendingOwner ? { pendingOwner: "question" in request.pendingOwner ? { question: request.pendingOwner.question } : time(request.pendingOwner) } : {}),
    ...(request.holdCleanup?.length ? { cleanupPending: true } : {}),
  };
}

const holds = (request: Request): HoldRef[] => request.offered.flatMap(o => o.holdId ? [{ holdId: o.holdId, account: o.account }] : []);
const sameHold = (a: HoldRef, b: HoldRef) => a.holdId === b.holdId && a.account === b.account;

async function calendar(args: string[]): Promise<string | undefined> {
  return runOnMac({ argv: ["plow-gog", "calendar", ...args], readPaths: [], timeoutMs: 60_000,
    goal: "Meetly: update this conversation's meeting and its temporary holds" }).catch(() => undefined);
}

async function cleanup(request: Request, remove: HoldRef[]): Promise<Request> {
  const pending = [...(request.holdCleanup ?? []), ...remove].filter((h, i, all) => all.findIndex(x => sameHold(h, x)) === i)
    .filter(h => !(request.status === "booked" && h.holdId === request.eventId && h.account === request.booked?.account));
  request = patch(request, { holdCleanup: pending });
  for (const hold of pending) {
    const result = await calendar(["delete", "primary", hold.holdId, "--send-updates", "none", "--force", "--account", hold.account]);
    if (result !== undefined) request = patch(request, { holdCleanup: request.holdCleanup!.filter(h => !sameHold(h, hold)) });
  }
  return request;
}

// Remove only this request's own holds, including their account, from busy time.
async function busyFor(request: Request, config: Config, from: string, to: string): Promise<BusyResult> {
  const result = await fetchBusy(config, { from, to });
  if (result.degraded.length) throw new Error("calendar unavailable");
  return { ...result, busy: result.busy.filter(b => !holds(request).some(h => h.holdId === b.id && h.account === b.account)) };
}

function intersection(owner: Constraints = {}, guest: Constraints = {}): Constraints {
  return {
    days: owner.days && guest.days ? owner.days.filter(d => guest.days!.includes(d)) : owner.days ?? guest.days,
    after: [owner.after, guest.after].filter(Boolean).sort().at(-1),
    before: [owner.before, guest.before].filter(Boolean).sort()[0],
    from: [owner.from, guest.from].filter(Boolean).sort().at(-1),
    to: [owner.to, guest.to].filter(Boolean).sort()[0],
  };
}

function preferences(args: GuestArgs): Constraints {
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
  return out;
}

function withinConditions(request: Request, start: string, config: Config): boolean {
  const constraints = request.constraints ?? {};
  const p = wallParts(Date.parse(start), config.timezone);
  const date = localIso(Date.parse(start), config.timezone).slice(0, 10);
  const end = localIso(Date.parse(start) + request.durationMin * 60_000, config.timezone);
  const clock = localIso(Date.parse(start), config.timezone).slice(11, 16);
  return !(constraints.days && !constraints.days.includes(p.weekday)) && !(constraints.from && date < constraints.from)
    && !(constraints.to && date > constraints.to) && !(constraints.after && clock < constraints.after)
    && !(constraints.before && (end.slice(0, 10) !== date || end.slice(11, 16) > constraints.before));
}

async function check(request: Request, config: Config, start: string) {
  const query = { now: Date.now(), config, durationMin: request.durationMin, start, locale: request.locale, allowOverlap: request.allowOverlap };
  const { slot } = checkTime({ ...query, busy: [] });
  const busy = await busyFor(request, config, slot.start, slot.end);
  const checked = checkTime({ ...query, ...busy });
  const overlap = busy.busy.some(b => b.id && request.allowOverlap?.includes(b.id)
    && Date.parse(b.start) < Date.parse(slot.end) && Date.parse(b.end) > Date.parse(slot.start));
  return { ...checked, overlap };
}

function formatArgs(request: Pick<Request, "format" | "location">): string[] {
  if (request.format === "meet") return ["--with-meet"];
  if (request.format === "phone") return ["--location=Phone call"];
  // Latch scans standalone flags before gog parses them; keep guest text in the value.
  return request.location ? [`--location=${request.location}`] : [];
}

function record(request: Request, event: EventInfo, account: string, change: Patch = {}): Request {
  const result = updateJson<Ledger>(file("ledger.json"), EMPTY, l =>
    recordBooking(updateRequest(l, request.id, change, Date.now()), request.id, event, account, Date.now()).ledger);
  return result.requests.find(r => r.id === request.id)!;
}

async function pick(request: Request, config: Config, start: string) {
  const offer = request.offered.find(o => Date.parse(o.start) === Date.parse(start));
  if (!offer) return { error: "Choose one of the currently offered start times." };
  const checked = await check(request, config, offer.start);
  if (!checked.free || checked.outsideHours || !withinConditions(request, offer.start, config)) return { error: "That time is no longer available. Ask for other times." };
  let holdId = offer.holdId;
  if (holdId) {
    const existing = await calendar(["event", "primary", holdId, "--account", offer.account, "--json"]);
    if (existing === undefined) throw new Error("hold unavailable");
    if (parseEvent(existing).status === "cancelled") holdId = undefined;
  }
  const contact = await lookupContact(request.handle);
  const email = request.handle.includes("@") ? request.handle : contact.found && contact.matches === 1 ? contact.emails[0] : undefined;
  const account = holdId ? offer.account : config.defaultAccount;
  const output = await calendar([
    ...(holdId ? ["update", "primary", holdId] : ["create", "primary"]),
    "--summary", `${request.topic} with ${request.name ?? request.handle}`,
    "--from", offer.start, "--to", offer.end, "--account", account, "--send-updates", "all", "--json",
    ...formatArgs(request), ...(email ? ["--attendees", email] : []),
    ...(!holdId && checked.overlap ? ["--confirm-conflict"] : []),
  ]);
  if (output === undefined) throw new Error("booking failed");
  const event = parseEvent(output);
  if ((holdId && event.id !== holdId) || Date.parse(event.start) !== Date.parse(offer.start) || Date.parse(event.end) !== Date.parse(offer.end)) throw new Error("unexpected booking");
  request = record(request, event, account);
  request = await cleanup(request, holds(request));
  return { ...view(request, config), invitationSent: !!email, overlappedWithOwnerApproval: checked.overlap };
}

async function otherTimes(request: Request, config: Config, args: GuestArgs) {
  const now = Date.now();
  const busy = await busyFor(request, config, localIso(now, config.timezone), localIso(now + (config.horizonDays + 1) * 86_400_000, config.timezone));
  const narrowed = intersection(request.constraints, preferences(args));
  const query: SlotQuery = { ...busy, ...narrowed, days: narrowed.days as Day[] | undefined, now, config,
    durationMin: request.durationMin, allowOverlap: request.allowOverlap, locale: request.locale, exclude: request.offered.map(o => o.start) };
  let { slots } = findSlots(query);
  const preferencesUnavailable = slots.length === 0;
  if (preferencesUnavailable) {
    slots = findSlots({ ...query, ...intersection(request.constraints), days: request.constraints?.days as Day[] | undefined }).slots;
  }
  if (!slots.length) return { error: "No other times are available within the owner's conditions. The current offer is unchanged." };
  request = await cleanup(request, holds(request));
  const offered: Offer[] = [];
  try {
    for (const slot of slots) {
      const checked = await check(request, config, slot.start);
      if (!checked.free || checked.outsideHours) continue;
      const output = await calendar(["create", "primary", "--summary", `Hold: ${request.topic} with ${request.name ?? request.handle}`,
        "--from", slot.start, "--to", slot.end, "--send-updates", "none", "--account", config.defaultAccount, "--json",
        ...(checked.overlap ? ["--confirm-conflict"] : [])]);
      if (output === undefined) continue;
      const event = parseEvent(output);
      offered.push({ start: event.start, end: event.end, holdId: event.id, account: config.defaultAccount });
    }
    if (!offered.length) return { error: "No replacement holds could be created. The previous times need rechecking before booking." };
    request = patch(request, { offered });
  } catch (error) {
    await cleanup(request, offered.flatMap(o => o.holdId ? [{ holdId: o.holdId, account: o.account }] : []));
    throw error;
  }
  return { ...view(request, config), ...(preferencesUnavailable
    ? { message: "The requested preferences are unavailable. Offer these new times within the owner's conditions instead." } : {}) };
}

async function askOwner(request: Request, config: Config, args: GuestArgs, sendOwner?: SendOwner) {
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
    if (!checked.free) return { error: "That time is not available. Offer the current times or ask for other times." };
    if (!checked.outsideHours) return { error: "That time is within working hours. Ask for other times to get an offer." };
    pendingOwner = { start: checked.slot.start, end: checked.slot.end, askedAt };
    question = `Can we meet ${localeFormatter(request.locale ?? "en-US", config.timezone).format(new Date(checked.slot.start))} (${config.timezone}), outside your working hours?`;
  }
  updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
    const latest = l.requests.find(r => r.id === request.id);
    if (!latest || latest.pendingOwner || latest.status !== request.status) throw new Error("request changed");
    return updateRequest(l, request.id, { pendingOwner }, Date.now());
  });
  // Keep the slot on an uncertain send so another turn cannot duplicate it.
  try {
    const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
    await sendOwner(`${label(request.name ?? "Your guest")} in your ${label(request.topic)} group asks: ${JSON.stringify(question)} — what should I tell them?`);
  } catch {
    return { error: "I could not confirm delivery to the owner. The question remains pending; do not send it again." };
  }
  return { ownerName: config.ownerName, message: "I will check with the owner and get back to you here." };
}

export async function guestAction(ctx: GuestContext, action: GuestAction, args: GuestArgs = {}, sendOwner?: SendOwner): Promise<object> {
  try {
    let request = resolveRequest(ctx);
    if (!request) return { error: "No scheduling request matches you in this conversation." };
    const config = loadConfig();
    if (action === "view") return view(request, config);
    if (config.paused) return { error: "Scheduling is paused. The owner can resume it." };
    if (action === "format") {
      if (request.status !== "offered" && request.status !== "booked") return view(request, config);
      if (!["meet", "in_person", "phone", "unknown"].includes(args.format ?? "")) return { error: "Choose meet, in_person, phone, or unknown." };
      if (args.location !== undefined && (typeof args.location !== "string" || args.location.length > 1000)) return { error: "Provide a short meeting place." };
      const change = { format: args.format!, location: args.location ?? "" };
      if (request.status === "booked") {
        if (!request.eventId || !request.booked) throw new Error("missing booking");
        const output = await calendar(["update", "primary", request.eventId, "--account", request.booked.account,
          "--send-updates", "all", "--json", ...formatArgs(change)]);
        if (output === undefined) throw new Error("format update failed");
        request = record(request, parseEvent(output), request.booked.account, change);
      } else request = patch(request, change);
      return view(request, config);
    }
    if (action === "ask_owner" && (request.status === "offered" || (request.status === "booked" && args.question !== undefined))) {
      return await askOwner(request, config, args, sendOwner);
    }
    if (request.status !== "offered") return { ...view(request, config), message: "Changes to closed requests must go through the owner in this conversation." };
    if (action === "decline") {
      request = patch(request, { status: "dropped", pendingOwner: null });
      return view(await cleanup(request, holds(request)), config);
    }
    if (action === "other_times") return await otherTimes(request, config, args);
    if (!args.start) return { error: "Provide a start time." };
    if (action === "pick") return await pick(request, config, args.start);
    return { error: "Unknown scheduling action." };
  } catch {
    // Backend output can contain private event details, contact data, and accounts.
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
