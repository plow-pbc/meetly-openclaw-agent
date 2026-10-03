import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { loadConfig } from "./config.ts";
import type { NewRequest } from "./ledger.ts";

type Context = { messageChannel?: string; agentAccountId?: string; senderIsOwner?: boolean; requesterSenderId?: string;
  sessionKey?: string; nativeChannelId?: string };
export type GroupRequest = Pick<NewRequest, "handle" | "name" | "topic" | "durationMin" | "constraints" | "proposed" | "format" | "location" | "locale" | "offered">;

export async function offerOwnerGroup(ctx: Context, args: GroupRequest, options: CalendarOptions = {}): Promise<object> {
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || ctx.senderIsOwner !== true
    || !ctx.requesterSenderId || !ctx.sessionKey?.includes(":plow:group:") || !ctx.nativeChannelId) {
    return { error: "Only the owner's own Plow group turn can start this request." };
  }
  try {
    if (loadConfig().paused) return { error: "Scheduling is paused." };
    const { handle, name, topic, durationMin, constraints, proposed, format, location, locale, offered } = args;
    return await offerRequest({ handle, name, topic, durationMin, constraints, proposed, format, location, locale, offered,
      origin: "owner", startedInGroup: true, chatUid: ctx.nativeChannelId }, {
      ...options,
      validate(request) {
        if (request.chatUid !== ctx.nativeChannelId || !request.startedInGroup) throw new Error("This person already has a request outside this owner-started group.");
        options.validate?.(request);
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
