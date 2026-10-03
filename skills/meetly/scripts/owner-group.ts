import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { fetchBusy } from "./busy.ts";
import { durationFor } from "./slots.ts";
import { loadConfig } from "./config.ts";
import { view } from "./request-view.ts";
import type { NewRequest } from "./ledger.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<NewRequest, "handle" | "name" | "topic" | "meal" | "constraints" | "proposed" | "format" | "location" | "locale"> & { allowOverlapTitles?: string[]; durationMin?: number; offered: { start: string; end: string }[] };

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat || !ctx.sessionKey?.includes(":plow:group:")) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  try {
    const config = loadConfig();
    if (config.paused) return { error: "Scheduling is paused." };
    const { handle, name, topic, meal, durationMin, constraints, proposed, format, location, locale, offered } = args;
    let allowOverlap: string[] | undefined;
    if (args.allowOverlapTitles?.length) {
      const starts = offered.map(slot => Date.parse(slot.start)), ends = offered.map(slot => Date.parse(slot.end));
      const busy = await fetchBusy(config, { from: new Date(Math.min(...starts)).toISOString(), to: new Date(Math.max(...ends)).toISOString() }, { allowOverlapTitles: args.allowOverlapTitles });
      if (busy.degraded.length || busy.unknownAfter) throw new Error("calendar coverage incomplete");
      allowOverlap = busy.allowOverlap;
    }
    const { request } = await offerRequest({ handle, name, topic, meal, durationMin: durationFor({ config, meal, durationMin }), constraints, proposed, format, location, locale, ...(allowOverlap ? { allowOverlap } : {}),
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
