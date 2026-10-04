import { fetchBusy } from "./busy.ts";
import { calendarAction, offerRequest, type OfferInput } from "./calendar.ts";
import { lookupContact } from "./contact.ts";
import { durationFor, loadConfig } from "./config.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { findPreferredSlots } from "./slots.ts";
import { view } from "./request-view.ts";
import { checkContact, ContactConfirmationRequired, findOpenByHandle, intersectConstraints, normalizeHandle, sameHandle, type Ledger, type Constraints } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<OfferInput, "travel" | "topic" | "meal" | "constraints" | "proposed" | "format" | "location" | "locale" | "name">;

// Tool callers may fill unused optional fields with empty values.
function conditions(value?: Constraints): Constraints | undefined {
  const entries = Object.entries(value ?? {}).filter(([, v]) => Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim());
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest): Promise<object> {
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
    name = args.name?.trim() || name;
    const ledger = readJson<Ledger>(file("ledger.json"), { requests: [] });
    checkContact(ledger, handle);
    const existing = findOpenByHandle(ledger, handle);
    if (existing && existing.chatUid !== chat && !(existing.status === "asked" && existing.chatUid === undefined)) {
      throw new Error("request belongs to another conversation");
    }
    const config = loadConfig(), now = Date.now();
    if (config.paused) throw new Error("Scheduling is paused.");
    const { topic, format, location } = args;
    const meal = args.meal ?? existing?.meal;
    const durationMin = durationFor({ config, meal, durationMin: existing?.durationMin });
    const locale = args.locale ?? existing?.locale;
    const hard = conditions(args.constraints);
    const constraints = hard ? intersectConstraints(existing?.constraints, hard) : existing?.constraints;
    const proposed = conditions(args.proposed) ?? (existing?.status === "asked" ? existing.proposed : undefined);
    const busy = await fetchBusy(config, { from: new Date(now).toISOString(), to: new Date(now + (config.horizonDays + 1) * 86_400_000).toISOString() });
    if (busy.degraded.length) throw new Error("calendar unavailable");
    busy.busy = busy.busy.filter(b => !existing?.offered.some(o => o.holdId && o.holdId === b.id && o.account === b.account));
    const travel = existing?.travel?.override ? existing.travel : args.travel ?? existing?.travel;
    const query = { travel, format: format ?? existing?.format, ...busy, ...constraints, now, config, meal, durationMin, locale, allowOverlap: existing?.allowOverlap };
    const near = proposed?.from && proposed.from === proposed.to
      ? `${proposed.from}T${proposed.after || config.windowStart}` : undefined;
    const { slots, preferencesUnavailable } = findPreferredSlots(query, proposed, [{ ...query, near }]);
    if (!slots.length) return { error: "No times are available within the owner's conditions. The current request is unchanged." };
    const input = { travel, handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale,
      offered: slots.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      origin: "owner-group" as const, chatUid: chat, askDetails: false };
    // Existing requests use the saved duration, including explicit owner steering.
    const { request } = existing
      ? await calendarAction(existing.id, { action: "offer", request: input })
      : await offerRequest(input);
    return { ...view(request, config), preferencesUnavailable };
  } catch (error) {
    if (error instanceof ContactConfirmationRequired) return { error: error.message, doNotContact: true };
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
