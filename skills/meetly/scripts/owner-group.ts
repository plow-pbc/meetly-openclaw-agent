import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { fetchBusy } from "./busy.ts";
import { loadConfig } from "./config.ts";
import { view } from "./guest.ts";
import type { NewRequest } from "./ledger.ts";

type Context = { messageChannel?: string; agentAccountId?: string; senderIsOwner?: boolean; requesterSenderId?: string;
  sessionKey?: string; nativeChannelId?: string };
export type GroupRequest = Pick<NewRequest, "handle" | "name" | "topic" | "constraints" | "proposed" | "format" | "location" | "locale"> & { allowOverlapTitles?: string[]; durationMin?: number; offered: { start: string; end: string }[] };

export async function offerOwnerGroup(ctx: Context, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || ctx.senderIsOwner !== true
    || !ctx.requesterSenderId || !ctx.sessionKey?.includes(":plow:group:") || !ctx.nativeChannelId) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  try {
    const config = loadConfig();
    if (config.paused) return { error: "Scheduling is paused." };
    const { handle, name, topic, durationMin, constraints, proposed, format, location, locale, offered } = args;
    let allowOverlap: string[] | undefined;
    if (args.allowOverlapTitles?.length) {
      const starts = offered.map(slot => Date.parse(slot.start)), ends = offered.map(slot => Date.parse(slot.end));
      const busy = await fetchBusy(config, { from: new Date(Math.min(...starts)).toISOString(), to: new Date(Math.max(...ends)).toISOString() }, { allowOverlapTitles: args.allowOverlapTitles });
      if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
      allowOverlap = busy.allowOverlap;
    }
    const { request } = await offerRequest({ handle, name, topic, durationMin: durationMin ?? config.durationMin, constraints, proposed, format, location, locale, ...(allowOverlap ? { allowOverlap } : {}),
      offered: offered.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      origin: "owner-group", chatUid: ctx.nativeChannelId }, {
      ...options,
      validate(request) {
        if (request.chatUid !== ctx.nativeChannelId || request.origin !== "owner-group") throw new Error("This person already has a request outside this owner-started group.");
        options.validate?.(request);
      },
    });
    return view(request, config);
  } catch {
    return { error: "The scheduling action could not be completed. Check the request before trying again." };
  }
}
