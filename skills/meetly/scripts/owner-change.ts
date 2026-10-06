import { answerOwner } from "./answer-owner.ts";
import { calendarAction, type CalendarOptions } from "./calendar.ts";
import { calendarOutput, sendOwnerTravel } from "./calendar-output.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { checkTravel, type Travel } from "./travel.ts";
import { file } from "./paths.ts";
import { updateJson } from "./store.ts";
import type { Ledger, Request } from "./ledger.ts";

type Args = { requestId: string; action: "format" | "travel"; travel: Travel; format?: Request["format"]; location?: string; confirmation?: string };

// Keep delivery attached to the calendar result: the private travel note and
// guest confirmation each have one destination and cannot become an owner final.
export async function changeOwnerMeeting(ctx: OwnerContext, args: Args,
  sendGuest: (to: string, text: string) => Promise<void>, sendOwner = sendOwnerTravel,
  options: CalendarOptions = {}): Promise<Record<string, unknown>> {
  if (!resolveOwnerChat(ctx) || ctx.sessionKey !== "agent:main:main") return { error: "Change meeting details from the owner's main DM." };
  try {
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
    const confirmation = args.action === "format" && !(request.formatConfirmation?.delivered && request.pendingOwner)
      ? request.formatConfirmation : undefined;
    if (unchanged && !request.pendingOwner && (args.action === "travel" || confirmation?.delivered || !confirmation)) return { unchanged: true, silent: true, effectiveTravel: request.travel };
    if (confirmation?.attemptedAt) throw new Error("Guest delivery is unconfirmed. Do not repeat the change or send.");
    const output = await calendarOutput(result, sendOwner);
    if (args.action === "travel") return { ...output, effectiveTravel: request.travel, silent: output.ownerNotified === true || unchanged };
    const text = confirmation?.text ?? args.confirmation!;
    if (confirmation) updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => ({ ...l, requests: l.requests.map(r => {
      if (r.id !== request.id) return r;
      if (r.calendarRevision !== request.calendarRevision || r.formatConfirmation?.text !== text || r.formatConfirmation.attemptedAt) throw new Error("Meeting or delivery changed. Read it before trying again.");
      return { ...r, formatConfirmation: { ...r.formatConfirmation, attemptedAt: new Date().toISOString() } };
    }) }));
    if (request.pendingOwner) {
      const answer = await answerOwner(ctx, { requestId: request.id, askedAt: request.pendingOwner.askedAt,
        text, outcome: "calendar_change" }, sendGuest);
      if ("email" in answer && !("error" in answer)) return { ...output, effectiveTravel: request.travel, guestConfirmation: answer, silent: output.ownerNotified === true };
      if (!("answered" in answer) || !answer.answered) return { ...output, error: "The meeting was updated, but guest delivery is unconfirmed. Do not repeat the change or send.", guestConfirmation: { delivered: false } };
    } else if (request.channel === "email") {
      return { ...output, effectiveTravel: request.travel, guestConfirmation: { delivered: false, tool: "plow_send_email", to: request.chatUid, body: text }, silent: output.ownerNotified === true };
    } else {
      if (!request.chatUid) throw new Error("The meeting was updated, but no guest conversation is linked.");
      try { await sendGuest(request.chatUid, text); }
      catch { return { ...output, error: "The meeting was updated, but guest delivery is unconfirmed. Do not repeat the change or send.", guestConfirmation: { delivered: false } }; }
    }
    if (confirmation) updateJson<Ledger>(file("ledger.json"), { requests: [] }, l => ({ ...l, requests: l.requests.map(r =>
      r.id === request.id && r.calendarRevision === request.calendarRevision ? { ...r, formatConfirmation: { ...r.formatConfirmation!, delivered: true } } : r) }));
    return { ...output, effectiveTravel: request.travel, guestConfirmation: { delivered: true }, silent: output.ownerNotified !== false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The meeting change could not be completed." };
  }
}
