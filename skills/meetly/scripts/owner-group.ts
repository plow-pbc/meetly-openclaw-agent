import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { fetchBusy } from "./busy.ts";
import { durationFor } from "./slots.ts";
import { loadConfig } from "./config.ts";
import { view } from "./request-view.ts";
import type { Constraints, NewRequest } from "./ledger.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type GroupRequest = Pick<NewRequest, "handle" | "name" | "topic" | "meal" | "constraints" | "proposed" | "format" | "location" | "locale"> & { allowOverlapTitles?: string[]; durationMin?: number; offered: { start: string; end: string }[] };

// Tool callers may fill unused optional fields with empty values.
function conditions(value?: Constraints): Constraints | undefined {
  const entries = Object.entries(value ?? {}).filter(([, v]) => Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim());
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function offerOwnerGroup(ctx: OwnerContext, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (chat && ctx.sessionKey === "agent:main:main") {
    return { error: 'This tool is group-only. Nothing was saved or sent. Continue in this DM: read meetly-group, "Owner request", find times and save the offer with calendar.ts offer (origin: owner), then follow "Offer times" delivery steps to call plow_start_thread with the guest and opener. Do not retry meetly_offer_owner_group here.' };
  }
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
    const { request } = await offerRequest({ handle, name, topic, meal, durationMin: durationFor({ config, meal, durationMin }), constraints: conditions(constraints), proposed: conditions(proposed), format, location, locale, ...(allowOverlap ? { allowOverlap } : {}),
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
