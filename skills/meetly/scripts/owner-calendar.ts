import { answerOwner } from "./answer-owner.ts";
import { calendarAction, type CalendarOptions } from "./calendar.ts";
import { calendarOutput, sendOwnerTravel } from "./calendar-output.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { checkTravel, type Travel } from "./travel.ts";
import type { Request } from "./ledger.ts";

type Args = { requestId: string; action: "travel" | "format"; travel: Travel; format?: Request["format"]; location?: string; confirmation?: string };

export async function changeOwnerMeeting(ctx: OwnerContext, args: Args,
  sendOwner = sendOwnerTravel, options: CalendarOptions = {}, sendGuest?: (to: string, text: string) => Promise<void>): Promise<Record<string, unknown>> {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") {
    return { error: "Change travel or place from the owner's main DM." };
  }
  try {
    checkTravel(args.travel);
    if (!args.requestId || !["travel", "format"].includes(args.action)) throw new Error("Provide a requestId and action: travel or format.");
    if (args.action === "format" && !["meet", "phone", "in_person", "unknown"].includes(args.format ?? "")) throw new Error("Provide the meeting format.");
    if (args.action === "format" && (typeof args.confirmation !== "string" || !args.confirmation.trim())) throw new Error("Provide the guest confirmation before changing the meeting.");
    if (args.action === "format" && args.format === "in_person" && (typeof args.location !== "string" || !args.location.trim())) throw new Error("Provide location for an in-person change before confirming it to the guest.");
    // A place estimate cannot override the owner's explicit travel correction.
    const travel = { beforeMin: args.travel.beforeMin, afterMin: args.travel.afterMin,
      ...(args.action === "travel" ? { override: true } : {}) };
    const result = await calendarAction(args.requestId, args.action === "travel"
      ? { action: "travel", travel }
      : { action: "format", format: args.format, location: args.location, travel }, options);
    const output = await calendarOutput(result, sendOwner);
    const request = result.request;
    // Text delivery is part of the tool: only confirmed sends may silence the owner turn.
    if (args.action === "format" && request.channel !== "email") {
      delete output.ownerReply;
      if ("unchanged" in result && result.unchanged && !request.pendingOwner) {
        return { ...output, effectiveTravel: request.travel, silent: true };
      }
      try {
        if (!sendGuest || !request.chatUid) throw new Error("Guest messaging is unavailable.");
        if (request.pendingOwner) {
          const answer = await answerOwner(ctx, { requestId: request.id, askedAt: request.pendingOwner.askedAt,
            outcome: "calendar_change", text: args.confirmation }, sendGuest);
          if (!("answered" in answer) || answer.answered !== true || !("sent" in answer) || answer.sent !== true) {
            throw new Error("Guest confirmation is incomplete.");
          }
          delete (output.request as Request).pendingOwner;
        } else await sendGuest(request.chatUid, args.confirmation!.trim());
        return { ...output, effectiveTravel: request.travel, guestConfirmation: { delivered: true },
          ...((output.ownerNotified === true || output.unchanged === true) ? { silent: true } : {}) };
      } catch {
        return { ...output, effectiveTravel: request.travel, guestConfirmation: { delivered: false },
          error: "The calendar is up to date, but guest delivery could not be confirmed. Report this privately; do not retry the change or resend automatically." };
      }
    }
    const guestConfirmation = args.action !== "format" ? undefined : request.pendingOwner
      ? { delivered: false, tool: "meetly_answer_owner", requestId: request.id,
        askedAt: request.pendingOwner.askedAt, outcome: "calendar_change" }
      : { delivered: false, tool: "plow_send_email", to: request.chatUid };
    return { ...output, effectiveTravel: request.travel, ...(guestConfirmation ? { guestConfirmation } : {}),
      ...(args.action === "travel" && output.ownerNotified === true ? { silent: true } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
