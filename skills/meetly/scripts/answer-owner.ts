import { offerRequest, type CalendarOptions } from "./calendar.ts";
import { rememberOverlap } from "./movable.ts";
import { formatMeetingTime } from "./time.ts";
import { loadConfig } from "./config.ts";
import { sameRequest, recordDelivery, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type Args = { requestId?: string; askedAt?: string; text?: string; outcome?: "answer" | "calendar_change" | "decline_alternatives" | "allow_overlap" | "refuse_overlap"; overlapChoice?: number; emailSent?: boolean };

export async function answerOwner(ctx: OwnerContext, args: Args, send: (to: string, text: string) => Promise<void>, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx, ["chat", "email"]);
  if (!chat) {
    return { error: "Only the owner's own Plow turn can answer a meeting question." };
  }
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "Provide the owner's answer." };
  if (!["answer", "calendar_change", "decline_alternatives", "allow_overlap", "refuse_overlap"].includes(args.outcome ?? "")) return { error: "Choose answer, calendar_change, decline_alternatives, allow_overlap or refuse_overlap for the matching pending decision." };
  const path = file("ledger.json");
  const ledger = readJson<Ledger>(path, { requests: [] });
  const request = ledger.requests.find(r => r.id === args.requestId);
  let pending = request?.pendingOwner;
  if (!request?.chatUid || !pending || "contact" in pending || pending.askedAt !== args.askedAt
    || (!["offered", "booked"].includes(request.status) && !(request.status === "asked" && "question" in pending && pending.overlap))) return { error: "No matching pending meeting question. Read the pending requests again." };
  const inGroup = chat === request.chatUid && ctx.agentAccountId === (request.channel === "email" ? "email" : "chat");
  if (!(ctx.agentAccountId === "chat" && ctx.sessionKey === "agent:main:main") && !inGroup) {
    return { error: "Answer from the owner's main DM or this request's group." };
  }
  const overlap = "question" in pending ? pending.overlap : undefined;
  const overlapAnswer = args.outcome === "allow_overlap" || args.outcome === "refuse_overlap";
  const choice = overlap?.choices[args.overlapChoice ?? 0];
  if (overlap || overlapAnswer) {
    if (!overlap || !overlapAnswer || !choice || (overlap.choices.length > 1 && args.overlapChoice === undefined)) return { error: "Choose a pending overlap candidate and allow_overlap or refuse_overlap." };
    if (ctx.agentAccountId !== "chat" || ctx.sessionKey !== "agent:main:main" || !ctx.turnStartedAt || ctx.turnStartedAt <= Date.parse(pending.askedAt)) return { error: "Wait for the owner's fresh answer in the main DM before resolving this overlap question." };
    if (args.emailSent && (!overlap.reply || overlap.answer?.choice !== (args.overlapChoice ?? 0) || !overlap.answer.allowed || args.outcome !== "allow_overlap")) return { error: "No matching overlap offer delivery to confirm." };
  }
  const alternatives = "question" in pending ? pending.alternatives : undefined;
  const declined = args.outcome === "decline_alternatives";
  if (declined && !alternatives) return { error: "No alternative search is pending." };
  if (alternatives && !declined && (!request.offered.length
    || request.offered.some(o => !o.holdId)
    || !request.offered.some(o => !alternatives.previousStarts.some(start => Date.parse(start) === Date.parse(o.start))))) {
    return { error: "Run the alternative search and hold new times before answering. Preserve the owner's saved conditions unless explicitly changed. Leave this decision pending if no times fit or the search or write fails." };
  }
  const alreadyVisible = inGroup && "question" in pending && ((args.outcome === "answer" && !alternatives) || declined);
  const emailReceipt = request.channel === "email" && args.emailSent === true;
  if (emailReceipt && !pending.answerAttemptedAt) return { error: "No email answer attempt to confirm." };
  if (!alreadyVisible && !emailReceipt) {

    try {
      const begun = updateJson<Ledger>(path, { requests: [] }, latest => {
        if (!sameRequest(latest.requests.find(r => r.id === request.id), request)) throw new Error("request changed");
        const begun = recordDelivery(latest, request.id, "answer", "begin", Date.now());
        if (overlap) {
          const current = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
          return updateRequest(begun, request.id, { pendingOwner: { ...current, question: "question" in pending! ? pending.question : "Overlap decision", overlap: { ...overlap, answer: { allowed: args.outcome === "allow_overlap", choice: args.overlapChoice ?? 0 } } } }, Date.now());
        }
        return begun;
      });
      pending = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
    } catch {
      return { error: "Answer delivery already attempted or request changed. Read pending requests; retry only after the owner explicitly authorizes clearing the attempt." };
    }
  }
  if (overlap && choice) {
    if (emailReceipt) args = { ...args, text: overlap.reply! };
    else {
      rememberOverlap(choice, args.outcome === "allow_overlap");
      if (args.outcome === "refuse_overlap") {
        try {
          updateJson<Ledger>(path, { requests: [] }, latest => {
            if (JSON.stringify(latest.requests.find(r => r.id === request.id)?.pendingOwner) !== JSON.stringify(pending)) throw new Error("question changed");
            return updateRequest(latest, request.id, { pendingOwner: null }, Date.now());
          });
        } catch { return { error: "The overlap question changed. Read pending requests again." }; }
        return { answered: true, sent: false, requestId: request.id, message: "No overlap authorized; the current offer is unchanged." };
      }
      try {
        const { id, origin, handle, name, channel, chatUid, topic, durationMin, format, location, meal, travel, constraints, locale, askDetails } = request;
        const result = await offerRequest({ requestId: id, origin, handle, name, channel, chatUid, topic, durationMin, format, location, meal, travel, constraints, locale, askDetails,
          offered: [{ start: choice.start, end: choice.end }] }, { ...options, overlapApproval: pending });
        if ("error" in result) throw new Error("Offer failed");
        const reply = `These times are held: ${result.request.offered.map(slot => formatMeetingTime(slot.start, loadConfig().timezone, request.locale)).join("; ")}. Which works for you?`;
        updateJson<Ledger>(path, { requests: [] }, latest => {
          const current = latest.requests.find(r => r.id === request.id)?.pendingOwner;
          if (JSON.stringify(current) !== JSON.stringify(pending) || !current || !("question" in current) || !current.overlap) throw new Error("question changed");
          pending = { ...current, overlap: { ...current.overlap, reply } };
          return updateRequest(latest, request.id, { pendingOwner: pending }, Date.now());
        });
        args = { ...args, text: reply };
      } catch { return { error: "Overlap offer could not be completed. The decision remains pending; reconcile any calendar operation before retrying. No booking was made." }; }
    }
  }
  if (request.channel === "email" && !alreadyVisible && !emailReceipt) {
    return { email: { to: request.chatUid, body: args.text!.trim() }, requestId: request.id, askedAt: pending.askedAt,
      message: "Send this answer with plow_send_email. Only after sent: true, call meetly_answer_owner again with these same fields and emailSent: true. Unknown delivery stays pending; do not resend." };
  }
  try {
    // The owner's words may already be visible, but a calendar change still needs its result delivered.
    if (!alreadyVisible && request.channel !== "email") await send(request.chatUid, args.text!.trim());
  } catch {
    return { error: "Answer delivery is unknown. The question remains pending; do not resend automatically." };
  }
  try {
    updateJson<Ledger>(path, { requests: [] }, latest => {
      const current = latest.requests.find(r => r.id === request.id)?.pendingOwner;
      if (!current || JSON.stringify(current) !== JSON.stringify(pending)) return latest;
      return updateRequest(latest, request.id, { pendingOwner: null }, Date.now());
    });
  } catch {
    return { error: "The answer is in the group, but its pending question could not be cleared. Do not resend; repair the ledger." };
  }
  return { answered: true, sent: !alreadyVisible, requestId: request.id,
    ...(inGroup && request.channel !== "email" ? { silent: true } : {}) };
}
