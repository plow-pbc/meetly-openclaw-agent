// Private suggestions and remembered answers never grant calendar permission.
import { toBusy, uniqueEvents, type EventRef } from "./busy.ts";
import { loadConfig, type Config } from "./config.ts";
import { parseCalendarObject } from "./event.ts";
import { requestEvents, type Ledger } from "./ledger.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { travelRange, type TravelInput } from "./travel.ts";

export type MovableArgs = TravelInput & { action: "inspect" | "remember"; requestId?: string;
  candidates?: { start: string; end: string }[]; title?: string; allowed?: boolean };

// A call the model can fix by changing its arguments; its message says how.
class ArgsError extends Error {}

export async function movableAction(ctx: OwnerContext, args: MovableArgs, options: BridgeOptions = {}) {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") return { error: "Only the owner's main DM can inspect or remember overlap decisions." };
  try {
    const path = file("config.json");
    const config = loadConfig();
    if (args.action === "remember") {
      const title = args.title?.trim().toLowerCase();
      if (!title || title.length > 1000 || typeof args.allowed !== "boolean") {
        throw new ArgsError("remember needs title (the blocking event's title from inspect) and allowed (true or false). Call it again with both.");
      }
      const decision = { allowed: args.allowed, at: new Date().toISOString() };
      updateJson<Config>(path, config, saved => ({ ...saved, overlapDecisions: { ...saved.overlapDecisions, [title]: decision } }));
      return { remembered: true, decision, grantsOverlap: false };
    }
    if (args.action !== "inspect" || !Array.isArray(args.candidates) || args.candidates.length < 1 || args.candidates.length > 2) {
      throw new ArgsError("inspect needs candidates: one or two {start, end} times, such as the busy slot just checked. Call it again with them.");
    }
    const request = args.requestId === undefined ? undefined : readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === args.requestId);
    if (args.requestId !== undefined && !request) throw new Error("unknown request");
    const own = request ? requestEvents(request).map(ref => ({ account: ref.account, id: ref.holdId })) : [];
    const travel = request ? { ...request, travel: request.travel?.override ? request.travel : args.travel ?? request.travel } : args;
    const ranges = args.candidates.map(slot => {
      if (!slot || !Number.isFinite(Date.parse(slot.start)) || !(Date.parse(slot.end) > Date.parse(slot.start))) throw new ArgsError("each candidate needs an ISO start and a later ISO end.");
      return { ...slot, ...travelRange(slot.start, slot.end, travel) };
    });
    const from = new Date(Math.min(...ranges.map(r => Date.parse(r.from)))).toISOString();
    const to = new Date(Math.max(...ranges.map(r => Date.parse(r.to)))).toISOString();
    const listings: unknown[] = [];
    const titles = new Map<string, string>();
    for (const account of new Set(config.calendars.map(c => c.account))) {
      const output = await runOnMac({ argv: ["plow-gog", "calendar", "events", "--calendars", config.calendars.filter(c => c.account === account).map(c => c.id).join(","),
        "--account", account, "--from", from, "--to", to, "--max", "100", "--json"],
        readPaths: [], timeoutMs: 60_000, goal: "Meetly: privately inspect a blocked meeting time" }, options);
      if (output === undefined) throw new Error("calendar unavailable");
      const raw = parseCalendarObject(output) as any;
      if (raw.errors?.length || raw.nextPageToken || !Array.isArray(raw.events ?? raw.items)) throw new Error("calendar coverage incomplete");
      const events = (raw.events ?? raw.items).map((event: any) => ({ ...event, account }));
      listings.push({ ...raw, events, items: undefined });
      for (const event of events) if (typeof event.summary === "string" && event.summary.trim()) {
        titles.set(JSON.stringify([account, event.id]), event.summary);
      }
    }
    const busy = toBusy(listings, { tz: config.timezone, max: 100 });
    if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
    const memory = readJson<Config>(path, config).overlapDecisions ?? {};
    return { candidates: ranges.flatMap(slot => {
      const blocking = busy.busy.filter(b => Date.parse(b.start) < Date.parse(slot.to) && Date.parse(b.end) > Date.parse(slot.from)
        && !own.some(ref => ref.account === b.account && ref.id === b.id));
      // Missing identity cannot prove there is exactly one distinct blocker.
      if (blocking.some(b => typeof b.id !== "string" || !b.id || !b.account)) return [];
      const events = uniqueEvents(blocking as EventRef[]);
      if (events.length !== 1) return [];
      const event = events[0]!;
      const title = titles.get(JSON.stringify([event.account, event.id]));
      if (!title) return [];
      const key = title.trim().toLowerCase();
      return [{ start: slot.start, end: slot.end, title,
        previous: Object.hasOwn(memory, key) ? memory[key] : null }];
    }) };
  } catch (error) {
    if (error instanceof ArgsError) return { error: error.message, code: "INVALID_ARGUMENTS" };
    return { error: "Could not inspect or remember the overlap decision. No permission was granted." };
  }
}
