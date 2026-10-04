import { offerRequest, type CalendarOptions, type OfferInput } from "./calendar.ts";
import { lookupContact } from "./contact.ts";
import { loadConfig } from "./config.ts";
import { view } from "./request-view.ts";
import { normalizeHandle, sameHandle } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<OfferInput, "topic" | "constraints" | "proposed" | "format" | "location" | "locale" | "durationMin" | "offered">;

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
    const { topic, durationMin, constraints, proposed, format, location, locale, offered } = args;
    const { request } = await offerRequest({ handle, name, topic, durationMin, constraints, proposed, format, location, locale,
      offered: offered.map(({ start, end }) => ({ start, end })),
      origin: "owner-group", chatUid: chat, askDetails: false }, options);
    return view(request, loadConfig());
  } catch {
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
