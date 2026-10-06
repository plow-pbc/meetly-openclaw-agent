import { answerOwner } from "./answer-owner.ts";
import { calendarAction, type CalendarOptions } from "./calendar.ts";
import { calendarOutput, sendOwnerTravel } from "./calendar-output.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { checkTravel, type Travel } from "./travel.ts";
import { file } from "./paths.ts";
import { updateJson } from "./store.ts";
import type { Ledger, Request } from "./ledger.ts";

type Args = { requestId: string; action: "format" | "travel"; travel: Travel; format?: Request["format"]; location?: string; confirmation?: string; emailSent?: boolean; confirmationAttemptedAt?: string };

// Keep delivery attached to the calendar result: the private travel note and
// guest confirmation each have one destination and cannot become an owner final.
export async function changeOwnerMeeting(ctx: OwnerContext, args: Args,
  sendGuest: (to: string, text: string) => Promise<void>, sendOwner = sendOwnerTravel,
  options: CalendarOptions = {}): Promise<Record<string, unknown>> {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") return { error: "Change meeting details from the owner's main DM." };
  try {
    if (args.emailSent === true) {
      const saved = updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => ({ ...l, requests: l.requests.map(r => {
        if (r.id !== args.requestId) return r;
        const confirmation = r.formatConfirmation;
        if (args.action !== "format" || r.channel !== "email" || !confirmation?.attemptedAt
          || confirmation.attemptedAt !== args.confirmationAttemptedAt || confirmation.text !== args.confirmation?.trim()) throw new Error("No matching email confirmation attempt.");
        return { ...r, formatConfirmation: { ...confirmation, delivered: true } };
      }) })).requests.find(r => r.id === args.requestId);
      if (!saved) throw new Error("No matching email confirmation attempt.");
      return { effectiveTravel: saved.travel, guestConfirmation: { delivered: true }, silent: true };
    }
    checkTravel(args.travel);
    if (!args.requestId || !["format", "travel"].includes(args.action)) throw new Error("Provide the request and change action.");
    if (args.action === "format") {
      if (!["meet", "phone", "in_person", "unknown"].includes(args.format ?? "")) throw new Error("Provide the meeting format.");
      if (!args.confirmation?.trim()) throw new Error("Provide a guest-facing confirmation before changing the meeting.");
      if (args.format === "in_person" && !args.location?.trim()) throw new Error("Provide the meeting place before changing it.");
    }
    const travel = { beforeMin: args.travel.beforeMin, afterMin: args.travel.afterMin,
      ...(args.action === "travel" ? { override: true } : {}) };
    const result = await calendarAction(args.requestId, args.action === "travel"
      ? { action: "travel", travel }
      : { action: "format", format: args.format, location: args.location, travel, confirmation: args.confirmation!.trim() }, options);
    const request = result.request;
    const unchanged = "unchanged" in result && result.unchanged === true;
    const question = request.pendingOwner && "question" in request.pendingOwner && !request.pendingOwner.alternatives;
    if (unchanged && !question && (args.action === "travel" || request.formatConfirmation?.delivered || !request.formatConfirmation)) return { unchanged: true, silent: true, effectiveTravel: request.travel };
    const output = await calendarOutput(result, sendOwner);
    if (args.action === "travel") return { ...output, effectiveTravel: request.travel, silent: output.ownerNotified === true || unchanged };
    let delivery: Record<string, unknown>;
    if (unchanged && question && (!request.formatConfirmation || request.formatConfirmation.delivered)) {
      const answer = await answerOwner(ctx, { requestId: request.id, askedAt: request.pendingOwner!.askedAt,
        text: args.confirmation, outcome: "calendar_change" }, sendGuest);
      delivery = "answered" in answer && answer.answered ? { guestConfirmation: { delivered: true } }
        : "email" in answer ? { guestConfirmation: answer } : { ...answer, guestConfirmation: { delivered: false } };
    } else delivery = await deliverFormatConfirmation(request, sendGuest);
    return { ...output, effectiveTravel: request.travel, ...delivery,
      ...("error" in delivery ? {} : { silent: request.channel === "email" ? output.ownerNotified === true : output.ownerNotified !== false }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The meeting change could not be completed." };
  }
}


export async function deliverFormatConfirmation(request: Request, sendGuest: (to: string, text: string) => Promise<void>): Promise<Record<string, unknown>> {
  try {
    const confirmation = request.formatConfirmation;
    if (!confirmation || confirmation.delivered) return { unchanged: true };
    const text = confirmation.text;
    const question = request.pendingOwner && "question" in request.pendingOwner && !request.pendingOwner.alternatives;
    request = updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => ({ ...l, requests: l.requests.map(r => {
      if (r.id !== request.id) return r;
      if (r.calendarRevision !== request.calendarRevision || r.formatConfirmation?.text !== text || r.formatConfirmation.attemptedAt
        || (question && (JSON.stringify(r.pendingOwner) !== JSON.stringify(request.pendingOwner) || r.pendingOwner?.answerAttemptedAt))) throw new Error("Meeting or delivery changed. Do not repeat the send.");
      const attemptedAt = new Date().toISOString();
      return { ...r, formatConfirmation: { ...r.formatConfirmation, attemptedAt },
        ...(question ? { pendingOwner: { ...r.pendingOwner!, answerAttemptedAt: attemptedAt } } : {}) };
    }) })).requests.find(r => r.id === request.id)!;
    if (!request.chatUid) throw new Error("The meeting was updated, but no guest conversation is linked.");
    if (request.channel === "email") return { guestConfirmation: question ? {
      email: { to: request.chatUid, body: text }, requestId: request.id, askedAt: request.pendingOwner!.askedAt,
      message: "After plow_send_email confirms sent:true, call meetly_answer_owner with outcome:calendar_change, this text and emailSent:true. Do not resend unknown delivery.",
    } : { delivered: false, tool: "plow_send_email", to: request.chatUid, body: text,
      receipt: { tool: "meetly_change_format", requestId: request.id, confirmation: text, confirmationAttemptedAt: request.formatConfirmation!.attemptedAt } } };
    await sendGuest(request.chatUid, text);
    updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => ({ ...l, requests: l.requests.map(r =>
      r.id === request.id && r.calendarRevision === request.calendarRevision && r.formatConfirmation?.attemptedAt === request.formatConfirmation!.attemptedAt
        ? { ...r, formatConfirmation: { ...r.formatConfirmation!, delivered: true },
          ...(question && JSON.stringify(r.pendingOwner) === JSON.stringify(request.pendingOwner) ? { pendingOwner: undefined } : {}) } : r) }));
    return { guestConfirmation: { delivered: true } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Guest delivery is unconfirmed. Do not repeat the send.", guestConfirmation: { delivered: false } };
  }
}
