import { fetchBusy } from "./busy.ts";
import { offerRequest, type CalendarOptions, type OfferInput } from "./calendar.ts";
import { lookupContact } from "./contact.ts";
import { loadConfig } from "./config.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { findSlots } from "./slots.ts";
import { view } from "./request-view.ts";
import { findOpenByHandle, intersectConstraints, normalizeHandle, sameHandle, type Ledger } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<OfferInput, "topic" | "constraints" | "proposed" | "format" | "location" | "locale" | "durationMin">;

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat || !ctx.sessionKey?.includes(":plow:group:")) {
    return { error: "Only the owner's own Plow group turn can start this request." };
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
    const existing = findOpenByHandle(readJson<Ledger>(file("ledger.json"), { requests: [] }), handle);
    if (existing && existing.chatUid !== chat && !(existing.status === "asked" && existing.chatUid === undefined)) {
      throw new Error("request belongs to another conversation");
    }
    const config = loadConfig(), now = (options.now ?? Date.now)();
    const { topic, format, location } = args;
    const durationMin = args.durationMin ?? existing?.durationMin ?? config.durationMin;
    const locale = args.locale ?? existing?.locale;
    const constraints = args.constraints ? intersectConstraints(existing?.constraints, args.constraints) : existing?.constraints;
    const proposed = args.proposed ?? (existing?.status === "asked" ? existing.proposed : undefined);
    const busy = await fetchBusy(config, { from: new Date(now).toISOString(), to: new Date(now + (config.horizonDays + 1) * 86_400_000).toISOString() });
    if (busy.degraded.length) throw new Error("calendar unavailable");
    busy.busy = busy.busy.filter(b => !existing?.offered.some(o => o.holdId && o.holdId === b.id && o.account === b.account));
    const query = { ...busy, now, config, durationMin, locale, allowOverlap: existing?.allowOverlap };
    let { slots } = findSlots({ ...query, ...intersectConstraints(constraints, proposed) });
    const preferencesUnavailable = slots.length === 0;
    if (preferencesUnavailable) slots = findSlots({ ...query, ...constraints }).slots;
    if (!slots.length) return { error: "No times are available within the owner's conditions. The current request is unchanged." };
    const { request } = await offerRequest({ handle, name, topic, durationMin, constraints, proposed, format, location, locale,
      offered: slots.map(({ start, end }) => ({ start, end })),
      origin: "owner-group", chatUid: chat, askDetails: false }, options);
    return { ...view(request, config), preferencesUnavailable };
  } catch {
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
