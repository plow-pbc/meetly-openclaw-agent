// Private suggestions and remembered answers never grant calendar permission.
import { toBusy, uniqueEvents, type EventRef } from "./busy.ts";
import { loadConfig } from "./config.ts";
import { calendarListings, eventTitle } from "./calendar-read.ts";
import { requestEvents, sameRequest, updateRequest, type Ledger, type OverlapChoice } from "./ledger.ts";
import { type BridgeOptions } from "./mac.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { travelRange, type TravelInput } from "./travel.ts";

export type MovableArgs = TravelInput & { action: "inspect"; requestId?: string;
  candidates?: { start: string; end: string }[] };

export async function movableAction(ctx: OwnerContext, args: MovableArgs, options: BridgeOptions = {}) {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") return { error: "Only the owner's main DM can inspect overlap decisions." };
  try {
    const path = file("ledger.json");
    const config = loadConfig();
    if (args.action !== "inspect" || !Array.isArray(args.candidates) || args.candidates.length < 1 || args.candidates.length > 2) throw new Error("inspect one or two candidate times");
    const request = args.requestId === undefined ? undefined : readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === args.requestId);
    if (args.requestId !== undefined && !request) throw new Error("unknown request");
    const own = request ? requestEvents(request).map(ref => ({ account: ref.account, id: ref.holdId })) : [];
    const travel = request ? { ...request, travel: request.travel?.override ? request.travel : args.travel ?? request.travel } : args;
    const ranges = args.candidates.map(slot => {
      if (!slot || !Number.isFinite(Date.parse(slot.start)) || !(Date.parse(slot.end) > Date.parse(slot.start))) throw new Error("candidate needs a valid start and later end");
      return { ...slot, ...travelRange(slot.start, slot.end, travel) };
    });
    const from = new Date(Math.min(...ranges.map(r => Date.parse(r.from)))).toISOString();
    const to = new Date(Math.max(...ranges.map(r => Date.parse(r.to)))).toISOString();
    const listings: unknown[] = [];
    const titles = new Map<string, string>();
    for (const { account, listing } of await calendarListings(config, { from, to }, options)) {
      if (!listing || listing.errors?.length || listing.nextPageToken || listing.nextPageTokens?.length) throw new Error("calendar coverage incomplete");
      listings.push(listing);
      for (const event of listing.events) if (typeof event.summary === "string" && event.summary.trim()) {
        titles.set(JSON.stringify([account, event.id]), eventTitle(event.summary));
      }
    }
    const busy = toBusy(listings, { tz: config.timezone, max: 100 });
    if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
    const memory = readJson<Decisions>(file("overlap-decisions.json"), {});
    const choices: OverlapChoice[] = ranges.flatMap(slot => {
      const blocking = busy.busy.filter(b => Date.parse(b.start) < Date.parse(slot.to) && Date.parse(b.end) > Date.parse(slot.from)
        && !own.some(ref => ref.account === b.account && ref.id === b.id));
      // Missing identity cannot prove there is exactly one distinct blocker.
      if (blocking.some(b => typeof b.id !== "string" || !b.id || !b.account)) return [];
      const events = uniqueEvents(blocking as EventRef[]);
      if (events.length !== 1) return [];
      const event = events[0]!;
      const title = titles.get(JSON.stringify([event.account, event.id]));
      if (!title) return [];
      return [{ start: slot.start, end: slot.end, title, event: { account: event.account, id: event.id } }];
    });
    const candidates = choices.map(({ event: _event, ...slot }) => ({ ...slot, previous: memory[slot.title.toLowerCase()] ?? null }));
    if (!request || !choices.length) return { candidates };
    if (!request.chatUid || !["offered", "booked"].includes(request.status)) throw new Error("inspect a linked scheduling request");
    const pendingOwner = { askedAt: new Date(Date.now()).toISOString(), question: "May I offer one of these times over its existing commitment, leaving that event unchanged?", overlap: { choices } };
    updateJson<Ledger>(path, { requests: [] }, latest => {
      const current = latest.requests.find(r => r.id === request.id);
      if (!sameRequest(current, request) || current?.pendingOwner) throw new Error("a decision is already pending or the request changed");
      return updateRequest(latest, request.id, { pendingOwner }, Date.now());
    });
    return { candidates, requestId: request.id, askedAt: pendingOwner.askedAt, question: pendingOwner.question };

  } catch {
    return { error: "Could not inspect the overlap decision. No permission was granted; resolve any existing pending question first." };
  }
}

type Decisions = Record<string, { allowed: boolean; at: string }>;
export function rememberOverlap(choice: OverlapChoice, allowed: boolean) {
  updateJson<Decisions>(file("overlap-decisions.json"), {}, saved => ({ ...saved,
    [choice.title.trim().toLowerCase()]: { allowed, at: new Date(Date.now()).toISOString() } }));
}
