import { TravelBaseRequired } from "./travel.ts";
import { fetchBusy } from "./busy.ts";
import { calendarAction, offerRequest, type OfferInput } from "./calendar.ts";
import { lookupContact } from "./contact.ts";
import { loadConfig } from "./config.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { findPreferredSlots, resolveSearchConstraints, preferredSearchCoverage, type SearchTiming } from "./slots.ts";
import { view } from "./request-view.ts";
import { checkContact, ContactConfirmationRequired, requireDuration, findOpenByHandle, normalizeHandle, sameHandle, type Ledger, type Constraints } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<OfferInput, "travel" | "topic" | "meal" | "constraints" | "proposed" | "format" | "location" | "locale" | "name"> & SearchTiming & { durationMin: number; requestId?: string };

// Tool callers may fill unused optional fields with empty values.
function conditions(value?: Constraints): Constraints | undefined {
  const entries = Object.entries(value ?? {}).filter(([, v]) => Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim());
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, sendOwner?: (text: string) => Promise<void>): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat || !ctx.sessionKey?.includes(":plow:group:")) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  if (!Number.isInteger(args.durationMin) || args.durationMin <= 0) {
    return { error: "Set durationMin to your chosen positive whole number of minutes when saving this request." };
  }
  try {
    const api = plowApi();
    const response = await api.fetch(`${api.base}/v1/chats/${encodeURIComponent(chat)}`, {
      headers: api.headers, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Chat participants unavailable");
    const current = await response.json() as Chat;
    const participants = current.participants ?? [];
    const guests = participants.filter(p => p.type === "member" && p.role !== "owner");
    if (current.uid !== chat || current.status !== "active" || participants.length !== 3 || guests.length !== 1 ||
      !participants.some(p => p.type === "member" && p.role === "owner") ||
      !participants.some(p => p.type === "agent" && p.relationship === "self")) {
      throw new Error("Expected the owner, one guest and this agent in the current chat");
    }
    const guest = guests[0]!;
    const handle = normalizeHandle(guest.provider_key ?? "");
    const displayName = guest.display_name?.trim();
    let name = displayName && displayName !== "unnamed member" && !sameHandle(displayName, handle) ? displayName : undefined;
    if (!name) {
      const contact = await lookupContact(handle);
      if (contact.found) name = contact.name?.trim() || undefined;
    }
    name = args.name?.trim() || name;
    const ledger = readJson<Ledger>(file("ledger.json"), { requests: [] });
    const coordinatePrivately = async (code: string, reason: string) => {
      const dates = (label: string, value?: Constraints) => {
        const parts = [value?.from && `from ${value.from}`, value?.to && `through ${value.to}`,
          value?.days?.length && `on ${value.days.join(", ")}`, value?.after && `after ${value.after}`, value?.before && `before ${value.before}`].filter(Boolean);
        return parts.length ? ` ${label}: ${parts.join("; ")} (${loadConfig().timezone}).` : "";
      };
      let ownerAskSent = false;
      try {
        if (sendOwner) {
          await sendOwner(`You asked in your group for ${args.durationMin}-minute ${JSON.stringify(args.topic)} with ${name ?? handle} (${handle}).`
            + dates("Required dates/times", args.constraints) + dates("Preferred dates/times", args.proposed)
            + (args.week ? ` Requested week: ${args.week}.` : "") + (args.asap ? " As soon as possible." : "")
            + (args.location ? ` Place: ${JSON.stringify(args.location)}.` : "")
            + (args.format ? ` Format: ${args.format}.` : "") + ` ${reason}`);
          ownerAskSent = true;
        }
      } catch {
        // An uncertain delivery is never retried or explained in the group.
      }
      return { code, silent: true, ownerAskSent, recovery: { action: "silent", retry: false } };
    };
    try {
      checkContact(ledger, handle);
    } catch (error) {
      if (!(error instanceof ContactConfirmationRequired)) throw error;
      return coordinatePrivately("OWNER_CONFIRMATION_REQUIRED",
        "You previously marked this person do not contact. Please confirm here in our private DM if you want to schedule this meeting. Your preference stays in place unless you ask to clear it.");
    }
    if (args.requestId === undefined && ledger.requests.some(r => r.status === "booked" && r.chatUid === chat && sameHandle(r.handle, handle))) {
      return coordinatePrivately("SEPARATE_MEETING_REQUIRED",
        "This group already has a booked meeting, which stays unchanged. I can arrange the separate meeting in a new conversation. Shall I do that?");
    }
    const existing = args.requestId === undefined ? findOpenByHandle(ledger, handle)
      : ledger.requests.find(r => r.id === args.requestId && ["asked", "offered", "booked"].includes(r.status)
        && r.chatUid === chat && sameHandle(r.handle, handle));
    if (args.requestId !== undefined && !existing) return { error: "Select a current request for this guest in this group." };
    if (existing && existing.chatUid !== chat && !(existing.status === "asked" && existing.chatUid === undefined)) {
      throw new Error("request belongs to another conversation");
    }
    const config = loadConfig(), now = Date.now();
    if (config.paused) throw new Error("Scheduling is paused.");
    const { topic, format } = args;
    const location = args.location ?? existing?.location;
    const meal = args.meal ?? existing?.meal;
    const durationMin = requireDuration(args.durationMin);
    const locale = args.locale ?? existing?.locale;
    if (args.week !== undefined && (args.proposed?.from || args.proposed?.to)) {
      return { error: "week resolves dates itself; omit proposed.from and proposed.to" };
    }
    const hard = conditions(resolveSearchConstraints(conditions(args.constraints) ?? {}, args.week, now, config.timezone));
    const constraints = args.constraints === undefined && args.week === undefined ? existing?.constraints : hard;
    const proposed = conditions(args.proposed) ?? (existing?.status === "asked" ? existing.proposed : undefined);
    const travel = existing?.travel?.override ? existing.travel : args.travel ?? existing?.travel;
    const search = { travel, format: format ?? existing?.format, ...constraints, excludedDays: existing?.excludedDays, now, config, meal, durationMin, locale, asap: args.asap, busy: [] };
    const range = preferredSearchCoverage(search, proposed);
    const busy = await fetchBusy(config, range);
    if (busy.degraded.length) throw new Error("calendar unavailable");
    busy.busy = busy.busy.filter(b => !existing?.offered.some(o => o.holdId && o.holdId === b.id && o.account === b.account));
    const query = { ...search, ...busy, ownerStartTime: constraints?.startTime, allowOverlap: existing?.allowOverlap };
    const near = !args.asap && proposed?.from && proposed.from === proposed.to
      ? `${proposed.from}T${proposed.after || config.windowStart}` : undefined;
    const { slots, preferencesUnavailable, incomplete, searched } = findPreferredSlots(query, proposed, [{ ...query, near }]);
    if (incomplete) return { error: "Calendar data is incomplete for the requested dates. Availability is not yet known; the current request is unchanged.", incomplete };
    if (!slots.length) return { error: "No times are available within the owner's conditions. The current request is unchanged.", searched };
    const input = { travel, handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale,
      offered: slots.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      origin: "owner-group" as const, chatUid: chat, askDetails: false };
    // Existing requests use the saved duration, including explicit owner steering.
    const { request } = existing
      ? await calendarAction(existing.id, { action: "offer", request: input })
      : await offerRequest(input);
    return { ...view(request, config), preferencesUnavailable, searched };
  } catch (error) {
    if (error instanceof TravelBaseRequired) return { error: "Provide your travel base in your private DM before offering in-person times.", code: "TRAVEL_BASE_REQUIRED" };
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
