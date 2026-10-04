import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { fetchBusy } from "./busy.ts";
import { loadConfig } from "./config.ts";
import { view } from "./request-view.ts";
import { normalizeHandle, sameHandle, type NewRequest } from "./ledger.ts";
import { plowApi, type Chat } from "./owner-chat.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<NewRequest, "topic" | "constraints" | "proposed" | "format" | "location" | "locale"> & { allowOverlapTitles?: string[]; durationMin?: number; offered: { start: string; end: string }[] };

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat || !ctx.sessionKey?.includes(":plow:group:")) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  try {
    const config = loadConfig();
    if (config.paused) return { error: "Scheduling is paused." };
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
    const name = displayName && displayName !== "unnamed member" && !sameHandle(displayName, handle) ? displayName : undefined;
    const { topic, durationMin, constraints, proposed, format, location, locale, offered } = args;
    let allowOverlap: string[] | undefined;
    if (args.allowOverlapTitles?.length) {
      const starts = offered.map(slot => Date.parse(slot.start)), ends = offered.map(slot => Date.parse(slot.end));
      const busy = await fetchBusy(config, { from: new Date(Math.min(...starts)).toISOString(), to: new Date(Math.max(...ends)).toISOString() }, { allowOverlapTitles: args.allowOverlapTitles });
      if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
      allowOverlap = busy.allowOverlap;
    }
    const { request } = await offerRequest({ handle, name, topic, durationMin: durationMin ?? config.durationMin, constraints, proposed, format, location, locale, ...(allowOverlap ? { allowOverlap } : {}),
      offered: offered.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      origin: "owner-group", chatUid: chat }, {
      ...options,
      validate(request) {
        if (request.chatUid !== chat || request.origin !== "owner-group") throw new Error("This person already has a request outside this owner-started group.");
        options.validate?.(request);
      },
    });
    return view(request, config);
  } catch {
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
