import { fetchBusy } from "./busy.ts";
import { offerRequest, type OfferInput } from "./calendar.ts";
import { lookupContact } from "./contact.ts";
import { DAYS, loadConfig } from "./config.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { findPreferredSlots, resolveSearchConstraints, preferredSearchCoverage, type SearchTiming } from "./slots.ts";
import { view } from "./request-view.ts";
import { requestEvents, sameRequest, nudgeFingerprint, checkContact, ContactConfirmationRequired, addRequest, requestId, findOpenByHandle, normalizeHandle, sameHandle, type Constraints, type Ledger } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<OfferInput, "requestId" | "travel" | "topic" | "meal" | "constraints" | "proposed" | "format" | "location" | "locale" | "name"> & SearchTiming & { durationMin: number };

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, sendOwner?: (text: string) => Promise<void>): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat || !ctx.sessionKey?.includes(":plow:group:")) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  if (!Number.isInteger(args.durationMin) || args.durationMin <= 0) {
    return { error: "Set durationMin to your chosen positive whole number of minutes when saving this request." };
  }
  const notifyOwner = async (text: string) => {
    if (!sendOwner) return false;
    try { await sendOwner(text); return true; }
    catch { return false; }
  };
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
    if (args.requestId === undefined && ledger.requests.some(r => r.status === "booked" && r.chatUid === chat)) {
      const id = requestId(), now = Date.now();
      updateJson<Ledger>(file("ledger.json"), { requests: [] }, current => addRequest(current, {
        origin: "owner-group", handle, name, topic: args.topic, durationMin: args.durationMin, travel: args.travel,
        meal: args.meal, format: args.format, location: args.location, locale: args.locale, proposed: args.proposed,
        constraints: resolveSearchConstraints(args.constraints ?? {}, args.week, now, loadConfig().timezone),
        askDetails: false, status: "asked", offered: [],
      }, now, id));
      const ownerAskSent = await notifyOwner(`Request ${id}: you asked in your group for ${args.durationMin} minutes. Topic: ${JSON.stringify(args.topic)}. Guest: ${JSON.stringify(name ?? handle)}.`
            + ` Conditions: ${JSON.stringify(args.constraints ?? {})}. Preferences: ${JSON.stringify(args.proposed ?? {})}.`
            + (args.week ? ` Week: ${args.week}.` : "") + (args.asap ? " As soon as possible." : "")
            + (args.location ? ` Place: ${JSON.stringify(args.location)}.` : "")
            + " This group already has a booked meeting, which stays unchanged. Shall I arrange the separate meeting in a new conversation?");
      return { code: "SEPARATE_MEETING_REQUIRED", silent: true, ownerAskSent, recovery: { action: "silent", retry: false } };
    }
    const existing = args.requestId === undefined ? findOpenByHandle(ledger, handle)
      : ledger.requests.find(r => r.id === args.requestId && ["asked", "offered", "booked"].includes(r.status)
        && r.chatUid === chat && sameHandle(r.handle, handle));
    if (args.requestId !== undefined && !existing) throw new Error("No matching selected request.");
    if (existing?.status === "booked" && args.durationMin !== existing.durationMin) throw new Error("Changing a booked duration is not supported.");
    if (existing && existing.chatUid !== chat && !(existing.status === "asked" && existing.chatUid === undefined)) {
      throw new Error("request belongs to another conversation");
    }
    const config = loadConfig(), now = Date.now();
    const { topic, format } = args;
    const location = args.location ?? existing?.location;
    const meal = args.meal ?? existing?.meal;
    const durationMin = args.durationMin;
    const locale = args.locale ?? existing?.locale;
    if (args.week !== undefined && (args.proposed?.from || args.proposed?.to)) {
      return { error: "week resolves dates itself; omit proposed.from and proposed.to" };
    }
    const { from: _from, to: _to, ...savedPolicy } = existing?.constraints ?? {};
    const constraints = args.constraints !== undefined || args.week !== undefined
      ? resolveSearchConstraints(args.constraints ?? savedPolicy, args.week, now, config.timezone) : existing?.constraints;
    const proposed = args.proposed ?? (existing?.status === "asked" ? existing.proposed : undefined);
    const travel = existing?.travel?.override ? existing.travel : args.travel ?? existing?.travel;
    try {
      checkContact(ledger, handle, existing);
    } catch (error) {
      if (!(error instanceof ContactConfirmationRequired)) throw error;
      const contact = { travel, origin: "owner-group" as const, handle, name, topic, meal, durationMin, constraints, proposed,
        format, location, locale, chatUid: chat, askDetails: false, offered: [], status: "asked" as const };
      let id = existing?.id ?? requestId();
      updateJson<Ledger>(file("ledger.json"), { requests: [] }, current => {
        const saved = args.requestId === undefined ? findOpenByHandle(current, handle)
          : current.requests.find(r => r.id === args.requestId);
        if (saved && saved.chatUid && saved.chatUid !== chat) throw new Error("request belongs to another conversation");
        id = saved?.id ?? id;
        if (!saved) current = addRequest(current, contact, now, id);
        return { ...current, requests: current.requests.map(r => r.id === id ? { ...r, pendingOwner: { contact, askedAt: new Date(now).toISOString() },
          lastNudge: { fingerprint: nudgeFingerprint("owner-decision", new Date(now).toISOString()), at: new Date(now).toISOString() }, chatUid: chat } : r) };
      });
      // The group receives only the coordination outcome, never the private reason.
      const dates = (label: string, value?: Constraints) => {
        const parts = [value?.from && `from ${value.from}`, value?.to && `through ${value.to}`,
          value?.days?.length && `on ${value.days.join(", ")}`, value?.after && `after ${value.after}`, value?.before && `before ${value.before}`].filter(Boolean);
        return parts.length ? ` ${label}: ${parts.join("; ")} (${loadConfig().timezone}).` : "";
      };
      const ownerAskSent = await notifyOwner(`Request ${id}: you asked in your group for ${args.durationMin} minutes. Topic: ${JSON.stringify(args.topic)}. Name: ${JSON.stringify(name ?? handle)}. Handle: ${JSON.stringify(handle)}.`
            + dates("Required dates/times", args.constraints) + dates("Preferred dates/times", args.proposed)
            + (args.location ? ` Place: ${JSON.stringify(args.location)}.` : "")
            + (args.format ? ` Format: ${args.format}.` : "")
            + " You previously marked this person do not contact. Please confirm here in our private DM if you want to schedule this meeting. Your preference stays in place unless you ask to clear it.");
      return { code: "OWNER_CONFIRMATION_REQUIRED", silent: true, ownerAskSent, recovery: { action: "silent", retry: false } };
    }
    const search = { travel, format: format ?? existing?.format, ...constraints, now, config, meal, durationMin, locale, asap: args.asap, busy: [] };
    const busy = await fetchBusy(config, preferredSearchCoverage(search, proposed));
    if (busy.degraded.length) throw new Error("calendar unavailable");
    busy.busy = busy.busy.filter(b => !existing || !requestEvents(existing).some(o => o.holdId === b.id && o.account === b.account));
    const query = { ...search, ...busy, allowOverlap: existing?.allowOverlap };
    query.days = (constraints?.days ?? DAYS).filter(day => !existing?.excludedDays?.includes(day));
    const near = !args.asap && proposed?.from && proposed.from === proposed.to
      ? `${proposed.from}T${proposed.after || config.windowStart}` : undefined;
    const { slots, preferencesUnavailable, incomplete } = findPreferredSlots(query, proposed, [{ ...query, near }]);
    if (incomplete && !slots.length) return { error: "Calendar data is incomplete for the requested dates. Availability is not yet known; the current request is unchanged.", incomplete };
    if (!slots.length) return { error: "No times are available within the owner's conditions. The current request is unchanged." };
    const { request } = await offerRequest({ requestId: existing?.id, travel, handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale,
      offered: slots.map(({ start, end }) => ({ start, end })),
      origin: "owner-group", chatUid: chat, askDetails: false }, {
      validate(latest) {
        if (existing && !sameRequest(existing, latest)) throw new Error("request changed");
      },
    });
    return { ...view(request, config), preferencesUnavailable };
  } catch (error) {
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
