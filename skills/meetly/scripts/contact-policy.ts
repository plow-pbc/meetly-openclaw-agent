import { calendarAction, type CalendarOptions, type OfferInput } from "./calendar.ts";
import { loadConfig } from "./config.ts";
import { doNotContact, sameRequest, setDoNotContact, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export function contactPreference(args: { handle: string; blocked: boolean; name?: string }) {
  if (typeof args.blocked !== "boolean") throw new Error("blocked must be a boolean");
  const ledger = updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => setDoNotContact(l, args.handle, args.blocked, Date.now(), args.name));
  return { doNotContact: doNotContact(ledger, args.handle) };
}

export async function confirmContactOffer(args: { requestId: string; offered: OfferInput["offered"] }, options: CalendarOptions = {}) {
  const path = file("ledger.json");
  const request = readJson<Ledger>(path, { requests: [] }).requests.find(r => r.id === args.requestId);
  if (!request || !["asked", "offered", "booked"].includes(request.status)) throw new Error("Choose an active saved request before confirming contact.");
  const { origin, handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale, chatUid, askDetails } = request.pendingContact ?? request;
  const offered = args.offered.map(o => ({ ...o, account: o.account ?? loadConfig().defaultAccount }));
  if (!offered.length || offered.some(o => Date.parse(o.end) - Date.parse(o.start) !== durationMin * 60_000)) throw new Error("Search times matching the saved request duration before confirming contact.");
  return calendarAction(request.id, { action: "offer", request: {
    origin, handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale, chatUid, askDetails, offered,
  } }, { ...options, confirmContact: true, validate(current) {
    options.validate?.(current);
    if (!sameRequest(request, current)) throw new Error("Request changed; read it before confirming contact.");
  } });
}
