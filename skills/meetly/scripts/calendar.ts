// Owns calendar writes and their ledger commits. A durable intent survives a
// lost Latch response or a failed ledger write; uncertain creates are never replayed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { allowsOverlap, fetchBusy, toBusy } from "./busy.ts";
import { isMain, run } from "./cli.ts";
import { durationFor, holdHours, loadConfig } from "./config.ts";
import { parseCalendarObject, parseEvent } from "./event.ts";
import { expiredRequests, findOpenByHandle, requestId, sameCleanup, uniqueCleanup, saveRequest, meetingTopic, updateRequest, type HoldCleanup, type HoldRef, type Ledger, type NewRequest, type Offer, type Patch, type Request } from "./ledger.ts";
import { macOutcome, runOnMacOutcome, type MacCommand, type MacOutcome } from "./mac.ts";
import { file } from "./paths.ts";
import { recordBooking } from "./record-booking.ts";
import { readJson, updateJson, withLock, writeJson } from "./store.ts";

export type CalendarAction =
  | { action: "offer"; request: NewRequest; provisional?: boolean }
  | { action: "book"; start: string; end?: string; attendees?: string }
  | { action: "format"; format: Request["format"]; location?: string }
  | { action: "drop" } | { action: "expire" } | { action: "cancel" } | { action: "cleanup" } | { action: "resume" };
type Step = { verb: "create" | "update"; account: string; eventId?: string; start: string; end: string; args: string[]; token: string; sentAt?: number; abandoned?: boolean; skipped?: boolean; handle?: string; output?: string };
type Intent = { id: string; input: Extract<CalendarAction, { action: "offer" | "book" | "format" }>; steps: Step[]; failed?: boolean };
export type CalendarOptions = { validate?: (request: Request) => void; command?: (command: MacCommand) => Promise<MacOutcome | undefined>; poll?: (handle: string) => Promise<MacOutcome | undefined>; now?: () => number };
const EMPTY: Ledger = { requests: [] };
const CREATE_WAIT_MS = 10 * 60_000;
const ledger = () => readJson<Ledger>(file("ledger.json"), EMPTY);
const requestById = (id: string) => {
  const request = ledger().requests.find(r => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  return request;
};
const holds = (r: Request): HoldRef[] => r.offered.flatMap(o => o.holdId ? [{ holdId: o.holdId, account: o.account }] : []);
const checkedEvent = (step: Step) => {
  const event = parseEvent(step.output!);
  if (event.status === "cancelled" || Date.parse(event.start) !== Date.parse(step.start) || Date.parse(event.end) !== Date.parse(step.end)
    || (step.verb === "update" && event.id !== step.eventId)) throw new Error("unexpected calendar event; operation kept for reconciliation");
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

export async function calendarAction(id: string, input: CalendarAction, options: CalendarOptions = {}) {
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
  return locked(id, async () => {
    const journal = file(`calendar/${encodeURIComponent(id)}.json`);
    let intent = readJson<Intent | undefined>(journal, undefined);
    let request = requestById(id);
    options.validate?.(request);
    if (intent && request.calendarRevision === intent.id) { rmSync(journal); intent = undefined; }
    if (intent && input.action !== "resume") throw new Error(`calendar operation unresolved for ${id}; run resume first`);
    if (!intent) {
      if (input.action === "resume" || input.action === "cleanup") { await cleanup(); return { request: requestById(id) }; }
      if (input.action === "expire" && !expiredRequests(ledger(), holdHours(), now()).some(r => r.id === id)) return { request, skipped: true };
      if (input.action === "expire" || input.action === "drop" || input.action === "cancel") {
        if (request.status === "booked" && input.action !== "cancel") return { request, skipped: true };
        const refs: HoldCleanup[] = holds(request);
        if (input.action === "cancel" && request.eventId && request.booked) refs.push({ holdId: request.eventId, account: request.booked.account, sendUpdates: "all" });
        patch({ status: input.action === "expire" ? "expired" : "dropped", pendingOwner: null,
          holdCleanup: uniqueCleanup([...(request.holdCleanup ?? []), ...refs]) }); await cleanup(); return { request: requestById(id) };
      }
      if (input.action === "format" && request.status === "offered") {
        patch({ format: input.format, location: input.location ?? "" });
        return { request: requestById(id) };
      }
      if (input.action === "format" ? request.status !== "booked" : request.status !== "offered" && request.status !== "asked") throw new Error(`request is ${request.status}`);
      const steps: Step[] = [];
      const add = (verb: Step["verb"], slot: Offer, args: string[]) => steps.push({ verb, account: slot.account, eventId: slot.holdId, start: slot.start, end: slot.end, args, token: randomUUID() });
      if (input.action === "offer") {
        if (input.request.offered.some(o => o.holdId)) throw new Error("offer slots must not supply hold ids");
        // Validate before any external effect; only the final commit replaces the old offer.
        const before = ledger();
        const validated = saveRequest(before, input.request, now(), id);
        input.request.allowOverlap = validated.requests.find(r => r.id === id)!.allowOverlap;
        if (validated.requests.length !== before.requests.length || validated.requests.find(r => r.id === id) === before.requests.find(r => r.id === id)) throw new Error("offer belongs to another request");
        for (const slot of input.request.offered) add("create", slot, ["--summary", `Hold: ${meetingTopic(input.request)} with ${input.request.name ?? input.request.handle}`, "--send-updates", "none"]);
      } else {
        const config = loadConfig();
        if (input.action === "format") updateRequest(ledger(), id, { format: input.format, location: input.location }, now());
        const slot: Offer = input.action === "format"
          ? { start: request.booked!.start, end: request.booked!.end, account: request.booked!.account, holdId: request.eventId }
          : request.offered.find(o => Date.parse(o.start) === Date.parse(input.start)) ?? { start: input.start, end: input.end!, account: config.defaultAccount };
        if (!slot.end || !(Date.parse(slot.end) > Date.parse(slot.start))) throw new Error("booking needs valid start and end");
        let verb: Step["verb"] = slot.holdId ? "update" : "create";
        if (slot.holdId) {
          const output = await call(["event", "primary", slot.holdId, "--json"], slot.account);
          if (output === undefined) throw new Error("cannot read existing calendar event");
          const raw = parseCalendarObject(output) as any;
          if ((raw.event ?? raw).status === "cancelled") {
            if (input.action === "format") throw new Error("booked event was cancelled");
            verb = "create";
          }
        }
        const format = input.action === "format" ? input.format : request.format;
        const location = input.action === "format" ? input.location ?? "" : request.location;
        add(verb, slot, ["--summary", `${meetingTopic(request)} with ${request.name ?? request.handle}`, "--send-updates", "all",
          ...(format === "meet" ? ["--with-meet"] : []),
          ...(format === "phone" ? ["--location=Phone call"] : location !== undefined ? [`--location=${location}`] : []),
          ...(input.action === "book" && input.attendees ? ["--attendees", input.attendees] : [])]);
      }
      intent = { id: randomUUID(), input, steps };
      writeJson(journal, intent);
    }
    const fail = async () => {
      const notification = intent.input.action === "book" ? { sendUpdates: "all" as const } : {};
      const created: HoldCleanup[] = intent.steps.filter(s => s.verb === "create" && s.output).map(s => ({ holdId: parseEvent(s.output!).id, account: s.account, ...notification }));
      created.push(...intent.steps.filter(s => s.abandoned).map(s => ({ token: s.token, account: s.account, start: s.start, end: s.end, ...notification })));
      queue(created);
      const provisional = intent.input.action === "offer" && intent.input.provisional;
      if (provisional) patch({ status: "dropped" });
      rmSync(journal);
      await cleanup();
      throw new Error(provisional ? "calendar write failed; new request dropped" : "calendar write failed; previous offer retained");
    };
    if (intent.failed) await fail();
    for (const step of intent.steps) {
      if (step.skipped) continue;
      if (step.output !== undefined) { checkedEvent(step); continue; }
      if (step.sentAt === undefined && !intent.failed) {
        const config = loadConfig();
        const results: unknown[] = [];
        for (const account of new Set(config.calendars.map(c => c.account))) {
          const ids = config.calendars.filter(c => c.account === account).map(c => c.id);
          const output = await call(["events", "--calendars", ids.join(","), "--from", step.start, "--to", step.end, "--max", "100", "--json"], account);
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
        const own = [...holds(requestById(id)), ...intent.steps.filter(s => s.output).map(s => ({ holdId: parseEvent(s.output!).id, account: s.account }))];
        if (request.eventId && request.booked) own.push({ holdId: request.eventId, account: request.booked.account });
        const overlaps = busy.busy.filter(b => Date.parse(b.start) < Date.parse(step.end) && Date.parse(b.end) > Date.parse(step.start));
        const allowed = intent.input.action === "offer" ? intent.input.request.allowOverlap : request.allowOverlap;
        if (overlaps.some(b => !own.some(h => h.holdId === b.id && h.account === b.account) && !allowsOverlap(b, allowed))) {
          if (intent.input.action === "offer") { step.skipped = true; writeJson(journal, intent); continue; }
          intent.failed = true; writeJson(journal, intent);
        } else if (step.verb === "create" && overlaps.length && !step.args.includes("--confirm-conflict")) step.args.push("--confirm-conflict");
      }
      if (step.sentAt === undefined && !intent.failed) {
        step.sentAt = now(); writeJson(journal, intent);
        const outcome = await send([step.verb, "primary", ...(step.verb === "update" ? [step.eventId!] : []),
          ...step.args, "--from", step.start, "--to", step.end, "--private-prop", `meetlyOperation=${step.token}`, "--json"], step.account);
        if (outcome && "output" in outcome) step.output = outcome.output;
        if (outcome && "handle" in outcome) step.handle = outcome.handle;
        if (outcome && "error" in outcome) {
          if (intent.input.action === "offer" && outcome.code === "calendar-conflict") step.skipped = true;
          else intent.failed = true;
        }
        writeJson(journal, intent);
      }
      if (step.handle && step.output === undefined && !intent.failed) {
        const outcome = await poll(step.handle).catch(() => undefined);
        if (outcome && "output" in outcome) step.output = outcome.output;
        if (outcome && "error" in outcome) {
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
      checkedEvent(step);
      writeJson(journal, intent);
    }
    if (intent.steps.every(s => s.skipped)) await fail();
    const completed = intent;
    updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
      let next: Ledger;
      if (completed.input.action === "offer") {
        const offered = completed.steps.filter(s => !s.skipped).map(s => { const e = parseEvent(s.output!); return { start: e.start, end: e.end, holdId: e.id, account: s.account }; });
        next = saveRequest(l, { ...completed.input.request, offered }, now(), id);
      } else {
        if (completed.input.action === "format") l = updateRequest(l, id, { format: completed.input.format, location: completed.input.location ?? "" }, now());
        const step = completed.steps[0]!;
        next = recordBooking(l, id, parseEvent(step.output!), step.account, now()).ledger;
      }
      return { requests: next.requests.map(r => {
        if (r.id !== id) return r;
        const cleanup = uniqueCleanup([...(r.holdCleanup ?? []), ...(r.status === "booked" ? holds(r) : [])])
          .filter(h => !(r.status === "booked" && r.eventId === h.holdId && r.booked?.account === h.account));
        return { ...r, calendarRevision: completed.id, holdCleanup: cleanup };
      }) };
    });
    rmSync(journal);
    await cleanup();
    request = requestById(id);
    return { request, invitationSent: completed.input.action === "book" && !!completed.input.attendees, meetUrl: request.meetUrl ?? null, ...(request.format === "meet" && request.status === "booked" && !request.meetUrl ? { warning: "no-meet-link" } : {}) };
  });
}

export type OfferInput = Omit<NewRequest, "durationMin" | "offered"> & {
  durationMin?: number; offered: (Omit<Offer, "account"> & { account?: string })[]; allowOverlapTitles?: string[];
};
export async function offerRequest({ allowOverlapTitles, ...args }: OfferInput, options: CalendarOptions = {}) {
  if (args.offered.some(o => o.holdId)) throw new Error("offer slots must not supply hold ids");
  const config = loadConfig();
  if (config.paused) throw new Error("Scheduling is paused.");
  const input: NewRequest = { ...args, durationMin: durationFor({ config, meal: args.meal, durationMin: args.durationMin }),
    offered: args.offered.map(slot => ({ ...slot, account: slot.account ?? config.defaultAccount })) };
  if (allowOverlapTitles?.length) {
    const busy = await fetchBusy(config, {
      from: new Date(Math.min(...input.offered.map(o => Date.parse(o.start)))).toISOString(),
      to: new Date(Math.max(...input.offered.map(o => Date.parse(o.end)))).toISOString(),
    }, { allowOverlapTitles });
    if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
    input.allowOverlap = [...(input.allowOverlap ?? []), ...(busy.allowOverlap ?? [])];
  }
  let id = "", provisional = false;
  updateJson<Ledger>(file("ledger.json"), EMPTY, l => {
    const existing = findOpenByHandle(l, input.handle) ?? l.requests.find(r => input.origin === "inbound" && input.sourceRowid !== undefined && r.sourceRowid === input.sourceRowid && ["asked", "offered"].includes(r.status));
    if (existing && input.chatUid && existing.chatUid !== input.chatUid &&
      !(input.origin === "owner-group" && existing.status === "asked" && existing.chatUid === undefined)) throw new Error("request belongs to another conversation");
    id = existing?.id ?? requestId();
    provisional = !existing;
    return existing ? l : saveRequest(l, input, (options.now ?? Date.now)(), id);
  });
  return calendarAction(id, { action: "offer", request: input, provisional }, options);
}

export async function resumePending(options: CalendarOptions = {}) {
  const results = [];
  for (const id of pendingCalendarWrites()) {
    try { results.push({ id, ...await calendarAction(id, { action: "resume" }, options) }); }
    catch (error) { results.push({ id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { results };
}

if (isMain(import.meta.url)) run(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: "string" }, json: { type: "string" }, "json-file": { type: "string" } } });
  const action = positionals[0];
  const args = values["json-file"] ? JSON.parse(readFileSync(values["json-file"], "utf8")) : JSON.parse(values.json ?? "{}");
  if (action === "resume-pending") return resumePending();
  if (action === "pending") return { ids: pendingCalendarWrites() };
  if (action === "offer") return offerRequest(args);
  if (!values.id || !["book", "format", "drop", "expire", "cancel", "cleanup", "resume"].includes(action ?? "")) throw new Error("usage: calendar.ts resume-pending | offer --json '<request>' | book|format|drop|expire|cancel|cleanup|resume --id X [--json '<args>']");
  return calendarAction(values.id, { ...args, action } as CalendarAction);
});
