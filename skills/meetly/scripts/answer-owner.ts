import { fetchBusy } from "./busy.ts";
import { findSlots, localeFormatter, searchCoverage } from "./slots.ts";
import { DAYS } from "./config.ts";
import { calendarAction, offerRequest, type CalendarOptions } from "./calendar.ts";
import { rememberOverlap } from "./movable.ts";
import { formatMeetingTime } from "./time.ts";
import { loadConfig } from "./config.ts";
import { sameRequest, requestEvents, recordDelivery, type Constraints, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type Args = { requestId?: string; askedAt?: string; text?: string; outcome?: "answer" | "calendar_change" | "decline_alternatives" | "allow_overlap" | "refuse_overlap"; overlapChoice?: number; emailSent?: boolean; constraints?: Constraints };

export async function answerOwner(ctx: OwnerContext, args: Args, send: (to: string, text: string) => Promise<void>, options: CalendarOptions = {}): Promise<object> {
  const chat = resolveOwnerChat(ctx, ["chat", "email"]);
  if (!chat) {
    return { error: "Only the owner's own Plow turn can answer a meeting question." };
  }
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "Provide the owner's answer." };
  if (!["answer", "calendar_change", "decline_alternatives", "allow_overlap", "refuse_overlap"].includes(args.outcome ?? "")) return { error: "Choose answer, calendar_change, decline_alternatives, allow_overlap or refuse_overlap for the matching pending decision." };
  const path = file("ledger.json");
  const ledger = readJson<Ledger>(path, { requests: [] });
  let request = ledger.requests.find(r => r.id === args.requestId);
  let pending = request?.pendingOwner;
  if (!request?.chatUid || !pending || "contact" in pending || pending.askedAt !== args.askedAt
    || (!["offered", "booked"].includes(request.status) && !(request.status === "asked" && "question" in pending && pending.overlap))) return { error: "No matching pending meeting question. Read the pending requests again." };
  let text = args.text.trim();
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
    if (args.emailSent && (args.outcome !== "allow_overlap" || !request.offered.some(slot => slot.holdId && Date.parse(slot.start) === Date.parse(choice.start) && Date.parse(slot.end) === Date.parse(choice.end)))) return { error: "No matching overlap offer delivery to confirm." };
  }
  const alternatives = "question" in pending ? pending.alternatives : undefined;
  const declined = args.outcome === "decline_alternatives";
  if (declined && !alternatives) return { error: "No alternative search is pending." };
  const skipDelivery = args.outcome === "refuse_overlap" || (inGroup && "question" in pending && ((args.outcome === "answer" && !alternatives) || declined));
  const emailReceipt = request.channel === "email" && args.emailSent === true;
  if (emailReceipt && !pending.answerAttemptedAt) return { error: "No email answer attempt to confirm." };
  if (!emailReceipt && pending.answerAttemptedAt) return { error: "Answer delivery already attempted. Retry only after the owner explicitly authorizes clearing the attempt." };
  if (alternatives && !declined && !emailReceipt) {
    try {
      const before = request;
      const config = loadConfig(), now = Date.now();
      if (config.paused || !["offered", "booked"].includes(request.status)) throw new Error("Scheduling is paused or this offer is no longer open.");
      const meeting = { ...request, ...request.replacement };
      const constraints = { ...request.constraints, ...args.constraints };
      const query = { ...constraints, now, config, busy: [], travel: meeting.travel, format: meeting.format, meal: request.meal, durationMin: request.durationMin,
        locale: request.locale, exclude: alternatives.previousStarts,
        days: (constraints.days ?? DAYS).filter(day => !before.excludedDays?.includes(day)) };
      const busy = await fetchBusy(config, searchCoverage(query));
      if (busy.degraded.length) throw new Error("Calendar unavailable. The alternative-search decision remains pending.");
      busy.busy = busy.busy.filter(b => !requestEvents(before).some(o => o.holdId === b.id && o.account === b.account));
      const { slots } = findSlots({ ...query, ...busy });
      if (!slots.length) throw new Error("No new times are available in the checked calendar range. The alternative-search decision remains pending.");
      const { origin, handle, name, sourceRowid, chatUid, channel, topic, location, travel, meal, durationMin, proposed, format, locale } = meeting;
      request = (await calendarAction(request.id, { action: "offer", request: {
        origin, handle, name, sourceRowid, chatUid, channel, topic, location, travel, meal, durationMin, constraints, proposed, format, locale,
        offered: slots.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      } }, { ...options, validate(latest) { options.validate?.(latest); if (!sameRequest(latest, before)) throw new Error("Request changed. Read pending requests again."); } })).request;
      const guestLocale = locale ?? "en-US";
      const labels = request.offered.map(o => localeFormatter(guestLocale, config.timezone).format(new Date(o.start)));
      const choices = new Intl.ListFormat(guestLocale, { type: "disjunction" }).format(labels);
      const sentences: Record<string, string> = {
        en: `${config.ownerName} is free ${choices}. Which time works for you?`,
        pt: `${config.ownerName} tem disponibilidade ${choices}. Qual horário funciona para você?`,
      };
      text = sentences[new Intl.Locale(guestLocale).language] ?? `${config.ownerName}: ${choices}?`;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Alternative search failed. The decision remains pending." };
    }
  }
  if (overlap && choice) {
    if (!emailReceipt) rememberOverlap(choice, args.outcome === "allow_overlap");
    if (!emailReceipt && !skipDelivery) {
      try {
        const { id, origin, handle, name, channel, chatUid, topic, durationMin, format, location, meal, constraints, locale, askDetails } = request;
        const result = await offerRequest({ requestId: id, origin, handle, name, channel, chatUid, topic, durationMin, format, location, meal, travel: overlap.travel, constraints, locale, askDetails,
          offered: [{ start: choice.start, end: choice.end }] }, { ...options, overlapApproval: { pending, choice: args.overlapChoice ?? 0 }, validate(latest) {
          options.validate?.(latest);
          if (!sameRequest(latest, request)) throw new Error("request changed");
        } });
        request = result.request;
      } catch { return { error: "Overlap offer could not be completed. The decision remains pending; reconcile any calendar operation before retrying. No booking was made." }; }
    }
    if (!skipDelivery) text = `These times are held: ${request.offered.map(slot => formatMeetingTime(slot.start, loadConfig().timezone, request!.locale)).join("; ")}. Which works for you?`;
  }
  if (!skipDelivery && !emailReceipt) {
    try {
      const begun = updateJson<Ledger>(path, { requests: [] }, latest => {
        const current = latest.requests.find(r => r.id === request!.id);
        if (JSON.stringify(current?.pendingOwner) !== JSON.stringify(pending)) throw new Error("pending question changed");
        if (!sameRequest(current, request)) throw new Error("request changed");
        return recordDelivery(latest, request!.id, "answer", "begin", Date.now());
      });
      pending = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
    } catch {
      return { error: "Answer delivery already attempted or request changed. Read pending requests; retry only after the owner explicitly authorizes clearing the attempt." };
    }
  }
  if (request.channel === "email" && !skipDelivery && !emailReceipt) {
    return { email: { to: request.chatUid, body: text }, requestId: request.id, askedAt: pending.askedAt,
      message: "Send this answer with plow_send_email. Only after sent: true, call meetly_answer_owner again with these same fields and emailSent: true. Unknown delivery stays pending; do not resend." };
  }
  try {
    // The owner's words may already be visible, but a calendar change still needs its result delivered.
    if (!skipDelivery && request.channel !== "email") await send(request.chatUid!, text);
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
    return { error: "The pending question could not be cleared. Do not resend; repair the ledger." };
  }
  return { answered: true, sent: !skipDelivery, requestId: request.id,
    ...(args.outcome === "refuse_overlap" ? { message: "No overlap authorized; the current offer is unchanged." } : {}),
    ...(inGroup && request.channel !== "email" ? { silent: true } : {}) };
}
