import { calendarAction, type CalendarOptions } from "./calendar.ts";
import { calendarOutput, sendOwnerTravel } from "./calendar-output.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { checkTravel, type Travel } from "./travel.ts";
import type { Request } from "./ledger.ts";

type Args = { requestId: string; action: "travel" | "format"; travel: Travel; format?: Request["format"]; location?: string };

export async function changeOwnerMeeting(ctx: OwnerContext, args: Args,
  sendOwner = sendOwnerTravel, options: CalendarOptions = {}): Promise<Record<string, unknown>> {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") {
    return { error: "Change travel or place from the owner's main DM." };
  }
  try {
    checkTravel(args.travel);
    if (!args.requestId || !["travel", "format"].includes(args.action)) throw new Error("Provide a requestId and action: travel or format.");
    if (args.action === "format" && !["meet", "phone", "in_person", "unknown"].includes(args.format ?? "")) throw new Error("Provide the meeting format.");
    // A place estimate cannot override the owner's explicit travel correction.
    const travel = { beforeMin: args.travel.beforeMin, afterMin: args.travel.afterMin,
      ...(args.action === "travel" ? { override: true } : {}) };
    const result = await calendarAction(args.requestId, args.action === "travel"
      ? { action: "travel", travel }
      : { action: "format", format: args.format, location: args.location, travel }, options);
    const output = await calendarOutput(result, sendOwner);
    const request = result.request;
    const guestConfirmation = args.action !== "format" ? undefined : request.pendingOwner
      ? { delivered: false, tool: "meetly_answer_owner", requestId: request.id,
        askedAt: request.pendingOwner.askedAt, outcome: "calendar_change" }
      : { delivered: false, tool: request.channel === "email" ? "plow_send_email" : "plow_reply_to", to: request.chatUid };
    return { ...output, effectiveTravel: request.travel, ...(guestConfirmation ? { guestConfirmation } : {}),
      ...(args.action === "travel" && output.ownerNotified === true ? { silent: true } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
