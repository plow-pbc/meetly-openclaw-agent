// Owns calendar writes and their ledger commits. A durable intent survives a
// lost Latch response or a failed ledger write; uncertain creates are never replayed.
import { calendarOutput } from "./calendar-output.ts";
import { checkTravel, checkTravelBase, travelFor, travelRange, travelNote, type Travel } from "./travel.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { allowsOverlap, fetchBusy, toBusy } from "./busy.ts";
import { isMain, run } from "./cli.ts";
import { holdHours, loadConfig } from "./config.ts";
import { parseCalendarObject, parseEvent } from "./event.ts";
import { checkContact, addRequest, requestEvents, requestHolds, sameHandle, expiredRequests, findOpenByHandle, requireDuration, requestId, sameCleanup, uniqueCleanup, saveRequest, updateRequest, type HoldCleanup, type HoldRef, type Ledger, type NewRequest, type Offer, type Patch, type Request } from "./ledger.ts";
import { macOutcome, runOnMacOutcome, type MacCommand, type MacOutcome } from "./mac.ts";
import { file } from "./paths.ts";
import { recordBooking } from "./record-booking.ts";
import { readJson, updateJson, withLock, writeJson } from "./store.ts";

export type CalendarAction =
  | { action: "offer"; request: NewRequest; provisional?: boolean }
  | { action: "duration"; durationMin: number; topic: string; offered: OfferInput["offered"] }
  | { action: "book"; start: string; end?: string; attendees?: string; timeApproval?: boolean; travel?: Travel }
  | { action: "format"; format: Request["format"]; location?: string; travel?: Travel }
  | { action: "travel"; travel: Travel }
  | { action: "attendee"; operation: "add" | "remove"; email: string }
  | { action: "drop" } | { action: "expire" } | { action: "cancel" } | { action: "cleanup" } | { action: "resume" };
type Step = { travel?: boolean; checkFrom?: string; checkTo?: string; verb: "create" | "update"; account: string; eventId?: string; start: string; end: string; args: string[]; token: string; sentAt?: number; abandoned?: boolean; skipped?: boolean; handle?: string; output?: string };
type Intent = { id: string; input: Extract<CalendarAction, { action: "offer" | "book" | "format" | "travel" | "attendee" }>; steps: Step[]; failed?: boolean };
export type CalendarOptions = { confirmContact?: boolean; validate?: (request: Request) => void; command?: (command: MacCommand) => Promise<MacOutcome | undefined>; poll?: (handle: string) => Promise<MacOutcome | undefined>; now?: () => number };
class TimeApprovalBusy extends Error {
  constructor() { super("Time approval cannot book a busy slot; no overlap was authorized."); }
}

const EMPTY: Ledger = { requests: [] };
const CREATE_WAIT_MS = 10 * 60_000;
const ledger = () => readJson<Ledger>(file("ledger.json"), EMPTY);
const requestById = (id: string) => {
  const request = ledger().requests.find(r => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  return request;
};
const holds = requestHolds;
// A replacement offer belongs to the booked record explicitly selected by id.
// Its slots change; the confirmed event and meeting details remain in place.
function saveOffer(l: Ledger, input: NewRequest, now: number, id: string): Ledger {
  const request = l.requests.find(r => r.id === id);
  if (request?.status !== "booked") return saveRequest(l, input, now, id);
  if (!sameHandle(request.handle, input.handle) || request.chatUid !== input.chatUid || (input.channel !== undefined && request.channel !== input.channel)) throw new Error("offer belongs to another request");
  const validated = addRequest(EMPTY, input, now, id).requests[0]!;
  if (validated.status !== "offered") throw new Error("replacement needs offered times");
  return updateRequest(l, id, {
    reoffer: { offered: validated.offered, offeredAt: new Date(now).toISOString() },
    holdCleanup: uniqueCleanup([...(request.holdCleanup ?? []), ...holds(request)]),
  }, now);
}
const checkedEvent = (step: Step, input: Intent["input"]) => {
  const event = parseEvent(step.output!);
  if (event.status === "cancelled" || Date.parse(event.start) !== Date.parse(step.start) || Date.parse(event.end) !== Date.parse(step.end)
    || (step.verb === "update" && event.id !== step.eventId)) throw new Error("unexpected calendar event; operation kept for reconciliation");
  if (input.action === "attendee") {
    const raw = parseCalendarObject(step.output!);
    const updated = (raw.event ?? raw) as { attendees?: { email?: string }[]; attendeesOmitted?: boolean };
    const present = updated.attendees?.some(a => a.email?.toLowerCase() === input.email) ?? false;
    if (updated.attendeesOmitted || present !== (input.operation === "add")) throw new Error("Attendee change not confirmed; run resume, do not repeat the write.");
  }
  return event;
};

// A live process owns its lock for the entire remote operation. Never expire
// it by age: an approval or a slow calendar call may still be running.
async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const path = file(`calendar/${encodeURIComponent(id)}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const acquired = withLock(file("calendar-locks"), () => {
      try { mkdirSync(path); writeFileSync(`${path}/pid`, String(process.pid)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      try {
        const pid = Number(readFileSync(`${path}/pid`, "utf8"));
        if (pid > 0) process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(path, { recursive: true });
      }
      return false;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw new Error(`calendar operation busy for ${id}`);
    await sleep(25);
  }
  try { return await fn(); } finally { rmSync(path, { recursive: true, force: true }); }
}

export function pendingCalendarWrites(): string[] {
  try { return readdirSync(file("calendar")).filter(name => name.endsWith(".json")).map(name => decodeURIComponent(name.slice(0, -5))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function calendarAction(id: string, action: CalendarAction, options: CalendarOptions = {}) {
  const now = options.now ?? Date.now;
  const command = options.command ?? runOnMacOutcome;
  const poll = options.poll ?? (handle => macOutcome("plow_get_result", { handle }));
  const send = async (args: string[], account: string) => command({
    argv: ["plow-gog", "calendar", ...args, "--account", account], readPaths: [], timeoutMs: 60_000,
    goal: "Meetly: maintain this request's calendar event and temporary holds",
  }).catch(() => undefined);
  const call = async (args: string[], account: string) => {
    const outcome = await send(args, account);
    return outcome && "output" in outcome ? outcome.output : undefined;
  };
  const patch = (change: Patch) => updateJson<Ledger>(file("ledger.json"), EMPTY, l => updateRequest(l, id, change, now()));
  const queue = (refs: HoldCleanup[]) => {
    updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
      const r = l.requests.find(r => r.id === id)!;
      const all = uniqueCleanup([...(r.holdCleanup ?? []), ...refs])
        .filter(h => !(r.status === "booked" && h.holdId === r.eventId && h.account === r.booked?.account));
      return updateRequest(l, id, { holdCleanup: all }, now());
    });
  };
  const cleanup = async () => {
    const refs = [...(requestById(id).holdCleanup ?? [])];
    for (const ref of refs) {
      if (ref.token !== undefined) {
        const output = await call(["events", "primary", "--from", ref.start, "--to", ref.end,
          "--private-prop-filter", `meetlyOperation=${ref.token}`, "--all-pages", "--json"], ref.account);
        if (output === undefined) continue;
        const raw = parseCalendarObject(output) as any;
        const matches = (raw.events ?? raw.items ?? []).filter((e: any) => e.extendedProperties?.private?.meetlyOperation === ref.token && e.id);
        // An empty search does not prove a delayed create will never arrive.
        if (!matches.length) continue;
        const found: HoldCleanup[] = matches.map((e: any) => ({ holdId: e.id, account: ref.account, ...(ref.sendUpdates ? { sendUpdates: ref.sendUpdates } : {}) }));
        queue(found);
        patch({ holdCleanup: (requestById(id).holdCleanup ?? []).filter(h => !sameCleanup(h, ref)) });
        refs.push(...found);
        continue;
      }
      const r = requestById(id);
      if (r.status === "booked" && r.eventId === ref.holdId && r.booked?.account === ref.account) {
        patch({ holdCleanup: (r.holdCleanup ?? []).filter(h => !sameCleanup(h, ref)) });
        continue;
      }
      const output = await call(["delete", "primary", ref.holdId, "--send-updates", ref.sendUpdates ?? "none", "--force"], ref.account);
      let removed = output !== undefined;
      if (!removed) {
        const check = await call(["event", "primary", ref.holdId, "--json"], ref.account);
        if (check !== undefined) { const raw = parseCalendarObject(check) as any; removed = (raw.event ?? raw).status === "cancelled"; }
      }
      if (removed) patch({ holdCleanup: (requestById(id).holdCleanup ?? []).filter(h => !sameCleanup(h, ref)) });
    }
  };
  // A queued initial pick must not become a move when another booking wins the lock.
  const wasBooked = action.action === "book" && requestById(id).status === "booked";
  return locked(id, async () => {
    const journal = file(`calendar/${encodeURIComponent(id)}.json`);
    let intent = readJson<Intent | undefined>(journal, undefined);
    let request = requestById(id);
    const booking = action.action === "book" && request.channel === "email" && request.status !== "booked"
      ? { ...action, attendees: [...new Set([request.handle, ...(action.attendees?.split(",") ?? [])].map(value => value.trim().toLowerCase()).filter(Boolean))].join(",") }
      : action;
    let input = booking.action === "book" && request.pendingOwner && "start" in request.pendingOwner
      ? { ...booking, timeApproval: true } : booking;
    options.validate?.(request);
    if ("travel" in input && input.travel !== undefined) checkTravel(input.travel);
    if (intent && request.calendarRevision === intent.id) { rmSync(journal); intent = undefined; }
    if (intent && input.action !== "resume") throw new Error(`calendar operation unresolved for ${id}; run resume first`);
    if (!intent) {
      if (input.action === "resume" || input.action === "cleanup") { await cleanup(); return { request: requestById(id) }; }
      if (input.action === "expire" && !expiredRequests(ledger(), holdHours(), now()).some(r => r.id === id)) return { request, skipped: true };
      if (input.action === "expire" || input.action === "drop" || input.action === "cancel") {
        if (request.status === "booked" && input.action === "drop") return { request, skipped: true };
        if (request.status === "booked" && input.action === "expire") {
          patch({ reoffer: null, holdCleanup: uniqueCleanup([...(request.holdCleanup ?? []), ...holds(request)]) });
          await cleanup();
          request = requestById(id);
          return { request, groupNotice: request.channel !== "email" && request.chatUid ? {
            chatUid: request.chatUid,
            text: request.holdCleanup?.length
              ? "The replacement offer expired; some holds still need cleanup. The original booking remains unchanged."
              : "The replacement times were released. The original booking remains unchanged.",
          } : undefined };
        }
        const refs: HoldCleanup[] = holds(request);
        if (input.action === "cancel") {
          refs.push(...(request.travelEvents ?? []));
          if (request.eventId && request.booked) refs.push({ holdId: request.eventId, account: request.booked.account, sendUpdates: "all" });
        }
        patch({ status: input.action === "expire" ? "expired" : "dropped", pendingOwner: null, reoffer: null,
          holdCleanup: uniqueCleanup([...(request.holdCleanup ?? []), ...refs]) }); await cleanup(); return { request: requestById(id) };
      }
      if (input.action === "offer") checkTravelBase(input.request, loadConfig().travelBase);
      if (input.action === "format" || input.action === "travel") {
        if (input.travel === undefined) throw new Error("Supply an explicit travel estimate");
        const format = input.action === "format" ? input.format : request.format;
        input.travel = request.travel?.override && !input.travel.override && format !== "meet" && format !== "phone" ? request.travel : input.travel;
        checkTravelBase({ format, travel: input.travel }, loadConfig().travelBase);
      }
      if ((input.action === "format" || input.action === "travel") && request.status === "offered") {
        patch({ ...(input.action === "format" ? { format: input.format, location: input.location ?? "" } : {}),
          travel: input.travel });
        return { request: requestById(id) };
      }
      if (input.action === "format" || input.action === "travel" || input.action === "attendee" ? request.status !== "booked" : request.status !== "offered" && request.status !== "asked" && !(request.status === "booked" && ((input.action === "book" && wasBooked) || input.action === "offer"))) throw new Error(`request is ${request.status}`);
      if (input.action === "duration") {
        const { origin, handle, name, channel, travel, meal, sourceRowid, chatUid, constraints, proposed, format, location, locale, askDetails } = request;
        const config = loadConfig();
        if (config.paused) throw new Error("Scheduling is paused.");
        const { durationMin } = input;
        if (input.offered.some(slot => Date.parse(slot.end) - Date.parse(slot.start) !== durationMin * 60_000)) {
          throw new Error("Replacement slots must match the new duration.");
        }
        input = { action: "offer", request: { origin, handle, name, channel, travel, meal, sourceRowid, chatUid, constraints, proposed,
          format, location, locale, askDetails, durationMin: input.durationMin, topic: input.topic,
          offered: input.offered.map(slot => ({ ...slot, account: config.defaultAccount })) } };
      }
      const steps: Step[] = [];
      const add = (verb: Step["verb"], slot: Offer, args: string[], range: { from: string; to: string }, travel = false) => steps.push({ verb, account: slot.account, eventId: slot.holdId, start: slot.start, end: slot.end, args, token: randomUUID(), checkFrom: range.from, checkTo: range.to, travel });
      if (input.action === "offer") {
        if (input.request.offered.some(o => o.holdId)) throw new Error("offer slots must not supply hold ids");
        // Validate before any external effect; only the final commit replaces the old offer.
        const before = ledger();
        const validated = saveOffer(before, input.request, now(), id);
        const saved = validated.requests.find(r => r.id === id)!;
        input.request.allowOverlap = saved.allowOverlap;
        input.request.name = saved.name;
        input.request.travel = saved.travel;
        input.request.format = saved.format;
        if (validated.requests.length !== before.requests.length || validated.requests.find(r => r.id === id) === before.requests.find(r => r.id === id)) throw new Error("offer belongs to another request");
        for (const slot of input.request.offered) add("create", slot, ["--summary", `Hold: ${input.request.topic} with ${input.request.name ?? input.request.handle}`, "--send-updates", "none"], travelRange(slot.start, slot.end, input.request));
      } else if (input.action === "attendee") {
        if (!["add", "remove"].includes(input.operation) || typeof input.email !== "string" || !/^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/.test(input.email.trim())) {
          throw new Error("Supply operation add or remove and one attendee email.");
        }
        const email = input.email = input.email.trim().toLowerCase();
        if (input.operation === "add") checkContact(ledger(), input.email, options.confirmContact);
        if (!request.eventId || !request.booked) throw new Error("Booked request has no calendar event.");
        const output = await call(["event", "primary", request.eventId, "--json"], request.booked.account);
        if (output === undefined) throw new Error("Cannot read the booked event's attendees.");
        const event = parseEvent(output);
        const raw = parseCalendarObject(output);
        const current = (raw.event ?? raw) as { attendees?: { email: string; organizer?: boolean; self?: boolean; optional?: boolean; resource?: boolean; comment?: string }[]; attendeesOmitted?: boolean };
        if (event.id !== request.eventId || event.status === "cancelled") throw new Error("Booked event is unavailable.");
        if (current.attendeesOmitted) throw new Error("Cannot edit an incomplete attendee list.");
        const attendees = current.attendees ?? [];
        const target = attendees.find(a => a.email.toLowerCase() === email);
        if (input.operation === "remove" && (target?.organizer || target?.self || sameHandle(input.email, request.booked.account))) throw new Error("Cannot remove the calendar owner; cancel the meeting instead.");
        if (!!target === (input.operation === "add")) return { request, invitationUpdated: false };
        const remaining = attendees.filter(a => a.email.toLowerCase() !== email);
        if (input.operation === "remove" && !remaining.some(a => !a.organizer && !a.self && !sameHandle(a.email, request.booked!.account))) {
          throw new Error("Cannot remove the last attendee; ask the owner whether to cancel the meeting instead.");
        }
        const emails = remaining.map(a => [a.email, ...(a.optional ? ["optional"] : []), ...(a.resource ? ["resource"] : []), ...(a.comment ? [`comment=${a.comment}`] : [])].join(";"));
        if (input.operation === "remove" && remaining.some(a => /[,;]/.test(a.email) || /[,;]/.test(a.comment ?? ""))) throw new Error("Cannot preserve this attendee list through the calendar command.");
        steps.push({ verb: "update", account: request.booked.account, eventId: event.id, start: event.start, end: event.end,
          args: [input.operation === "add" ? "--add-attendee" : "--attendees", input.operation === "add" ? input.email : emails.join(","), "--send-updates", "all"], token: randomUUID() });
      } else {
        const config = loadConfig();
        if (input.action === "format") updateRequest(ledger(), id, { format: input.format, location: input.location }, now());
        const start = input.action === "book" ? input.start : undefined;
        const slot: Offer = input.action === "format" || input.action === "travel"
          ? { start: request.booked!.start, end: request.booked!.end, account: request.booked!.account, holdId: request.eventId }
          : request.status === "booked" ? { start: input.start, end: input.end ?? new Date(Date.parse(input.start) + request.durationMin * 60_000).toISOString(), account: request.booked!.account, holdId: request.eventId }
          : request.offered.find(o => Date.parse(o.start) === Date.parse(start!)) ?? { start: input.start, end: input.end!, account: config.defaultAccount };
        if (!slot.end || !(Date.parse(slot.end) > Date.parse(slot.start)) || !Number.isInteger((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000)) throw new Error("booking needs valid start and end");
        if (input.action === "book" && request.offered.includes(slot) && Date.parse(slot.end) - Date.parse(slot.start) !== request.durationMin * 60_000) {
          throw new Error("Meeting duration changed; re-offer before booking an old hold.");
        }
        let verb: Step["verb"] = slot.holdId ? "update" : "create";
        if (slot.holdId) {
          const output = await call(["event", "primary", slot.holdId, "--json"], slot.account);
          if (output === undefined) throw new Error("cannot read existing calendar event");
          const raw = parseCalendarObject(output) as any;
          if ((raw.event ?? raw).status === "cancelled") {
            if (request.status === "booked") throw new Error("booked event was cancelled");
            verb = "create";
          }
        }
        const effective = { ...request, ...(input.action === "format" ? { format: input.format, location: input.location ?? "" } : {}),
          travel: request.travel?.override && !input.travel?.override && (input.action !== "format" || !["meet", "phone"].includes(input.format ?? "")) ? request.travel : input.travel ?? request.travel };
        checkTravelBase(effective, config.travelBase);
        input.travel = effective.travel;
        const range = travelRange(slot.start, slot.end, effective);
        const minutes = travelFor(effective);
        // Stage replacement children before changing the meeting. A failed write can
        // release these without moving or deleting the previous booking and travel.
        for (const side of ["before", "after"] as const) {
          const min = side === "before" ? minutes.beforeMin : minutes.afterMin;
          if (!min) continue;
          add("create", { account: slot.account, start: side === "before" ? range.from : slot.end,
            end: side === "before" ? slot.start : range.to },
          ["--summary", `Travel ${side === "before" ? "→" : "←"} ${effective.location || request.topic} (${min} min)`,
            "--send-updates", "none", "--visibility", "private", "--transparency", "opaque"], range, true);
        }
        const format = effective.format;
        const location = input.action === "format" ? input.location ?? "" : request.location;
        if (input.action !== "travel") add(verb, slot, ["--summary", `${request.topic} with ${request.name ?? request.handle}`, "--send-updates", "all",
          ...(format === "meet" ? ["--with-meet"] : []),
          ...(format === "phone" ? ["--location=Phone call"] : location !== undefined ? [`--location=${location}`] : []),
          ...(input.action === "book" && input.attendees ? ["--attendees", input.attendees] : [])], range);
      }
      intent = { id: randomUUID(), input, steps };
      writeJson(journal, intent);
    }
    const fail = async (error?: Error) => {
      const notification = intent.input.action === "book" ? { sendUpdates: "all" as const } : {};
      const created: HoldCleanup[] = intent.steps.filter(s => s.verb === "create" && s.output).map(s => ({ holdId: parseEvent(s.output!).id, account: s.account, ...(!s.travel ? notification : {}) }));
      created.push(...intent.steps.filter(s => s.abandoned).map(s => ({ token: s.token, account: s.account, start: s.start, end: s.end, ...(!s.travel ? notification : {}) })));
      queue(created);
      const provisional = intent.input.action === "offer" && intent.input.provisional;
      if (provisional) patch({ status: "dropped" });
      rmSync(journal);
      await cleanup();
      throw error ?? new Error(provisional ? "calendar write failed; new request dropped" : "calendar write failed; previous offer retained");
    };
    if (intent.failed) await fail();
    for (const step of intent.steps) {
      if (step.skipped) continue;
      if (step.output !== undefined) { checkedEvent(step, intent.input); continue; }
      if (step.sentAt === undefined && !intent.failed && intent.input.action !== "attendee") {
        const config = loadConfig();
        const results: unknown[] = [];
        for (const account of new Set(config.calendars.map(c => c.account))) {
          const ids = config.calendars.filter(c => c.account === account).map(c => c.id);
          const output = await call(["events", "--calendars", ids.join(","), "--from", step.checkFrom ?? step.start, "--to", step.checkTo ?? step.end, "--max", "100", "--json"], account);
          if (output === undefined) {
            if (intent.steps.every(s => s.sentAt === undefined)) await fail();
            throw new Error("calendar unavailable; no write attempted");
          }
          const raw = parseCalendarObject(output) as any;
          results.push({ ...raw, events: (raw.events ?? raw.items).map((e: object) => ({ ...e, account })) });
        }
        const busy = toBusy(results, { tz: config.timezone, max: 100 });
        if (busy.degraded.length || busy.unknownAfter) {
          if (intent.steps.every(s => s.sentAt === undefined)) await fail();
          throw new Error("calendar coverage incomplete; no write attempted");
        }
        const own = [...requestEvents(requestById(id)), ...intent.steps.filter(s => s.output).map(s => ({ holdId: parseEvent(s.output!).id, account: s.account }))];
        const overlaps = busy.busy.filter(b => Date.parse(b.start) < Date.parse(step.checkTo ?? step.end) && Date.parse(b.end) > Date.parse(step.checkFrom ?? step.start));
        const timeApproval = intent.input.action === "book" && intent.input.timeApproval;
        const allowed = timeApproval ? [] : intent.input.action === "offer" ? intent.input.request.allowOverlap : request.allowOverlap;
        if (overlaps.some(b => !own.some(h => h.holdId === b.id && h.account === b.account) && !allowsOverlap(b, allowed))) {
          if (intent.input.action === "offer") { step.skipped = true; writeJson(journal, intent); continue; }
          if (timeApproval) await fail(new TimeApprovalBusy());
          intent.failed = true; writeJson(journal, intent);
        } else if ((!timeApproval || step.travel) && step.verb === "create" && overlaps.length && !step.args.includes("--confirm-conflict")) step.args.push("--confirm-conflict");
      }
      if (step.sentAt === undefined && !intent.failed) {
        step.sentAt = now(); writeJson(journal, intent);
        const outcome = await send([step.verb, "primary", ...(step.verb === "update" ? [step.eventId!] : []),
          ...step.args, ...(intent.input.action === "attendee" ? [] : ["--from", step.start, "--to", step.end]), "--private-prop", `meetlyOperation=${step.token}`, "--private-prop", `meetlyRequest=${id}`, "--json"], step.account);
        if (outcome && "output" in outcome) step.output = outcome.output;
        if (outcome && "handle" in outcome) step.handle = outcome.handle;
        if (outcome && "error" in outcome) {
          if (outcome.code === "calendar-conflict" && intent.input.action === "book" && intent.input.timeApproval) await fail(new TimeApprovalBusy());
          if (intent.input.action === "offer" && outcome.code === "calendar-conflict") step.skipped = true;
          else intent.failed = true;
        }
        writeJson(journal, intent);
      }
      if (step.handle && step.output === undefined && !intent.failed) {
        const outcome = await poll(step.handle).catch(() => undefined);
        if (outcome && "output" in outcome) step.output = outcome.output;
        if (outcome && "error" in outcome) {
          if (outcome.code === "calendar-conflict" && intent.input.action === "book" && intent.input.timeApproval) await fail(new TimeApprovalBusy());
          if (intent.input.action === "offer" && outcome.code === "calendar-conflict") step.skipped = true;
          else intent.failed = true;
        }
        writeJson(journal, intent);
      }
      if (intent.failed) await fail();
      if (step.skipped) continue;
      if (step.verb === "update" && step.handle && step.output === undefined) {
        throw new Error(`calendar write unresolved for ${id}; approval is pending, run resume`);
      }
      if (step.output === undefined) {
        const output = await call(step.verb === "create"
          ? ["events", "primary", "--from", step.start, "--to", step.end, "--private-prop-filter", `meetlyOperation=${step.token}`, "--all-pages", "--json"]
          : ["event", "primary", step.eventId!, "--json"], step.account);
        if (output !== undefined) {
          const raw = parseCalendarObject(output) as any;
          const events = step.verb === "create" ? raw.events ?? raw.items ?? [] : [raw.event ?? raw];
          const matches = events.filter((e: any) => e.extendedProperties?.private?.meetlyOperation === step.token && e.status !== "cancelled");
          if (matches.length === 1) step.output = JSON.stringify(matches[0]);
        }
      }
      if (step.output === undefined) {
        if (step.verb === "create" && now() - step.sentAt! >= CREATE_WAIT_MS) {
          step.abandoned = true; intent.failed = true; writeJson(journal, intent);
          await fail();
        }
        throw new Error(`calendar write unresolved for ${id}; run resume, do not repeat the write`);
      }
      checkedEvent(step, intent.input);
      writeJson(journal, intent);
    }
    if (intent.input.action === "offer" && intent.steps.every(s => s.skipped)) await fail();
    const completed = intent;
    updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
      let next: Ledger;
      if (completed.input.action === "offer") {
        const offered = completed.steps.filter(s => !s.skipped).map(s => { const e = parseEvent(s.output!); return { start: e.start, end: e.end, holdId: e.id, account: s.account }; });
        next = saveOffer(l, { ...completed.input.request, offered }, now(), id);
      } else if (completed.input.action === "attendee") {
        next = l;
      } else {
        if (completed.input.action === "format") l = updateRequest(l, id, { format: completed.input.format, location: completed.input.location ?? "" }, now());
        const step = completed.steps.find(s => !s.travel);
        const before = l.requests.find(r => r.id === id)!;
        next = step ? recordBooking(l, id, parseEvent(step.output!), step.account, now()).ledger : l;
        next = updateRequest(next, id, { travel: completed.input.travel,
          travelEvents: completed.steps.filter(s => s.travel).map(s => ({ holdId: parseEvent(s.output!).id, account: s.account })),
          holdCleanup: uniqueCleanup([...(before.holdCleanup ?? []), ...(before.travelEvents ?? [])]),
        }, now());
        if (completed.input.action === "book") next = updateRequest(next, id, {
          reoffer: null, holdCleanup: uniqueCleanup([...(before.holdCleanup ?? []), ...(before.travelEvents ?? []), ...holds(before)]),
        }, now());
      }
      return { requests: next.requests.map(r => {
        if (r.id !== id) return r;
        const cleanup = uniqueCleanup(r.holdCleanup ?? [])
          .filter(h => !(r.status === "booked" && r.eventId === h.holdId && r.booked?.account === h.account));
        return { ...r, calendarRevision: completed.id, holdCleanup: cleanup };
      }) };
    });
    rmSync(journal);
    await cleanup();
    if (completed.input.action === "attendee") return { request: requestById(id), invitationUpdated: true };
    const releasedTravel = !!request.travelEvents?.length;
    request = requestById(id);
    let invitationUpdated = false;
    if (completed.input.action === "book") {
      const step = completed.steps.find(s => !s.travel)!;
      const raw = parseCalendarObject(step.output!);
      const event = (raw.event ?? raw) as { attendees?: { email?: string; organizer?: boolean; self?: boolean }[] };
      invitationUpdated = step.verb === "update" && Array.isArray(event.attendees)
        && event.attendees.some(a => typeof a?.email === "string" && !a.organizer && !a.self && !sameHandle(a.email, step.account));
    }
    return { request, ownerTravelNote: request.status === "booked" ? travelNote(request)
      ?? (releasedTravel ? `Travel time for ${request.topic} was released.` : undefined) : undefined, invitationSent: completed.input.action === "book" && !!completed.input.attendees,
      invitationUpdated,
      meetUrl: request.meetUrl ?? null, ...(request.format === "meet" && request.status === "booked" && !request.meetUrl ? { warning: "no-meet-link" } : {}) };
  });
}

// A yes to a time is distinct from permission to overlap a calendar event.
export async function approveTime(id: string, args: { start?: string; attendees?: string } = {}, options: CalendarOptions = {}) {
  const request = requestById(id);
  const pending = request.pendingOwner && "start" in request.pendingOwner ? request.pendingOwner : undefined;
  const start = args.start ?? pending?.start;
  if (!start) throw new Error("Time approval needs an exact start or a pending time approval.");
  const { checkTime } = await import("./slots.ts");
  const { slot } = checkTime({ now: (options.now ?? Date.now)(), config: loadConfig(), busy: [], start,
    travel: request.travel, meal: request.meal, durationMin: request.durationMin });
  try {
    return { ...await calendarAction(id, { action: "book", start: slot.start, end: slot.end,
      attendees: args.attendees, timeApproval: true }, options), approved: true };
  } catch (error) {
    if (!(error instanceof TimeApprovalBusy)) throw error;
    return { request: requestById(id), approved: false, code: "TIME_APPROVAL_BUSY", error: error.message,
      near: slot.start, recovery: { action: "find_nearest", allowOverlap: false } };
  }
}

export type OfferInput = Omit<NewRequest, "durationMin" | "offered"> & {
  durationMin?: number; offered: (Omit<Offer, "account"> & { account?: string })[]; allowOverlapTitles?: string[];
};
export async function offerRequest({ allowOverlapTitles, ...args }: OfferInput, options: CalendarOptions = {}) {
  if (args.offered.some(o => o.holdId)) throw new Error("offer slots must not supply hold ids");
  const config = loadConfig();
  if (config.paused) throw new Error("Scheduling is paused.");
  checkTravelBase(args, config.travelBase);
  const current = ledger();
  const saved = findOpenByHandle(current, args.handle) ?? current.requests.find(r => args.origin === "inbound" &&
    args.sourceRowid !== undefined && r.sourceRowid === args.sourceRowid && ["asked", "offered"].includes(r.status));
  const durationMin = requireDuration(args.durationMin === undefined ? saved?.durationMin : args.durationMin);
  if (args.offered.some(slot => Date.parse(slot.end) - Date.parse(slot.start) !== durationMin * 60_000)) {
    throw new Error("Every offered interval must match the request durationMin. Set the request duration and search again.");
  }
  const input: NewRequest = { ...args, durationMin,
    offered: args.offered.map(slot => ({ ...slot, account: slot.account ?? config.defaultAccount })) };
  if (allowOverlapTitles?.length) {
    const existing = findOpenByHandle(ledger(), input.handle);
    const effective = { ...input, format: input.format && input.format !== "unknown" ? input.format : existing?.format,
      travel: existing?.travel?.override ? existing.travel : input.travel ?? existing?.travel };
    const ranges = input.offered.map(slot => travelRange(slot.start, slot.end, effective));
    const busy = await fetchBusy(config, {
      from: new Date(Math.min(...ranges.map(r => Date.parse(r.from)))).toISOString(),
      to: new Date(Math.max(...ranges.map(r => Date.parse(r.to)))).toISOString(),
    }, { allowOverlapTitles });
    if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
    input.allowOverlap = [...(input.allowOverlap ?? []), ...(busy.allowOverlap ?? [])];
  }
  let id = "", provisional = false;
  updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
    checkContact(l, input.handle, options.confirmContact);
    const existing = findOpenByHandle(l, input.handle) ?? l.requests.find(r => input.origin === "inbound" && input.sourceRowid !== undefined && r.sourceRowid === input.sourceRowid && ["asked", "offered"].includes(r.status));
    if (existing && input.chatUid && existing.chatUid !== input.chatUid &&
      !(input.origin === "owner-group" && existing.status === "asked" && existing.chatUid === undefined)) throw new Error("request belongs to another conversation");
    id = existing?.id ?? requestId();
    provisional = !existing;
    return existing ? l : saveRequest(l, input, (options.now ?? Date.now)(), id);
  });
  return calendarAction(id, { action: "offer", request: input, provisional }, { ...options, validate(request) {
    options.validate?.(request);
    if (args.durationMin === undefined && request.durationMin !== durationMin) throw new Error("Request duration changed; read the saved request and search again.");
  } });
}

export async function resumePending(options: CalendarOptions = {}) {
  const results = [];
  for (const id of pendingCalendarWrites()) {
    try { results.push({ id, ...await calendarAction(id, { action: "resume" }, options) }); }
    catch (error) { results.push({ id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { results };
}

export async function calendarCommand(argv: string[], options: CalendarOptions & { sendOwner?: (text: string) => Promise<void> } = {}) {
  return calendarOutput(await executeCalendarCommand(argv, options), options.sendOwner);
}

async function executeCalendarCommand(argv: string[], options: CalendarOptions) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { id: { type: "string" }, json: { type: "string" }, "json-file": { type: "string" }, "confirm-contact": { type: "boolean" } } });
  const action = positionals[0];
  const args = values["json-file"] ? JSON.parse(readFileSync(values["json-file"], "utf8")) : JSON.parse(values.json ?? "{}");
  if (action === "resume-pending") return resumePending(options);
  if (action === "pending") return { ids: pendingCalendarWrites() };
  if ("allowOverlap" in args || "allowOverlapTitles" in args) throw new Error("Overlap authorization requires the owner DM tool meetly_offer_owner_dm.");
  if (action === "offer") checkContact(ledger(), args.handle, values["confirm-contact"]);
  if ((action === "book" || action === "approve-time") && values.id) checkContact(ledger(), requestById(values.id).handle, values["confirm-contact"]);
  if (action === "approve-time" && values.id) return approveTime(values.id, args, options);
  if (action === "offer") return values.id ? calendarAction(values.id, { action: "offer", request: args }, options) : offerRequest(args, { ...options, confirmContact: values["confirm-contact"] });
  if (!values.id || !["duration", "book", "format", "travel", "attendee", "drop", "expire", "cancel", "cleanup", "resume"].includes(action ?? "")) throw new Error("usage: calendar.ts resume-pending | offer --json '<request>' | duration|approve-time|book|format|travel|attendee|drop|expire|cancel|cleanup|resume --id X [--json '<args>']");
  return calendarAction(values.id, { ...args, action } as CalendarAction, { ...options, confirmContact: values["confirm-contact"] });
}

if (isMain(import.meta.url)) run(() => calendarCommand(process.argv.slice(2)));
