import { recordDelivery, updateRequest, type Constraints, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";
import { fetchBusy } from "./busy.ts";
import { calendarAction } from "./calendar.ts";
import { DAYS, loadConfig } from "./config.ts";
import { findSlots, localeFormatter, searchCoverage } from "./slots.ts";

type Args = { requestId?: string; askedAt?: string; text?: string; declineAlternatives?: boolean; constraints?: Constraints };

export async function answerOwner(ctx: OwnerContext, args: Args, send: (to: string, text: string) => Promise<void>): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat) {
    return { error: "Only the owner's own Plow turn can answer a meeting question." };
  }
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "Provide the owner's answer." };
  const path = file("ledger.json");
  const ledger = readJson<Ledger>(path, { requests: [] });
  const saved = ledger.requests.find(r => r.id === args.requestId);
  let pending = saved?.pendingOwner;
  if (!saved?.chatUid || !pending || pending.askedAt !== args.askedAt
    || !["offered", "booked"].includes(saved.status)) return { error: "No matching pending meeting question. Read the pending requests again." };
  let request = saved;
  let text = args.text.trim();
  const inGroup = chat === request.chatUid;
  if (ctx.sessionKey !== "agent:main:main" && !inGroup) {
    return { error: "Answer from the owner's main DM or this request's group." };
  }
  const alternatives = "question" in pending ? pending.alternatives : undefined;
  if (alternatives && args.declineAlternatives !== true) {
    if (pending.answerAttemptedAt) return { error: "Answer delivery already attempted. Do not repeat the search or send without the owner's explicit retry authorization." };
    try {
      const config = loadConfig(), now = Date.now();
      if (config.paused || request.status !== "offered") throw new Error("Scheduling is paused or this offer is no longer open.");
      const constraints = { ...request.constraints, ...args.constraints };
      const query = { ...constraints, now, config, busy: [], meal: request.meal, durationMin: request.durationMin,
        locale: request.locale, allowOverlap: request.allowOverlap, exclude: alternatives.previousStarts,
        days: (constraints.days ?? DAYS).filter(day => !request.excludedDays?.includes(day)) };
      const busy = await fetchBusy(config, searchCoverage(query));
      if (busy.degraded.length) throw new Error("Calendar unavailable. The alternative-search decision remains pending.");
      busy.busy = busy.busy.filter(b => !request.offered.some(o => o.holdId && o.holdId === b.id && o.account === b.account));
      const { slots } = findSlots({ ...query, ...busy });
      if (!slots.length) throw new Error("No new times are available in the checked calendar range. The alternative-search decision remains pending.");
      const before = request;
      const { origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, proposed, allowOverlap, format, locale } = request;
      request = (await calendarAction(request.id, { action: "offer", request: {
        origin, handle, name, sourceRowid, chatUid, topic, location, meal, durationMin, constraints, proposed, allowOverlap, format, locale,
        offered: slots.map(({ start, end }) => ({ start, end, account: config.defaultAccount })),
      } }, { validate(latest) { if (JSON.stringify(latest) !== JSON.stringify(before)) throw new Error("Request changed. Read pending requests again."); } })).request;
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
  const alreadyVisible = inGroup && "question" in pending && (!alternatives || args.declineAlternatives === true);
  if (!alreadyVisible) {
    try {
      const begun = updateJson<Ledger>(path, { requests: [] }, latest => {
        const current = latest.requests.find(r => r.id === request.id);
        if (JSON.stringify(current?.pendingOwner) !== JSON.stringify(pending)) throw new Error("pending question changed");
        if (JSON.stringify(current) !== JSON.stringify(request)) throw new Error("request changed");
        return recordDelivery(latest, request.id, "answer", "begin", Date.now());
      });
      pending = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
    } catch {
      return { error: "Answer delivery already attempted or request changed. Read pending requests; retry only after the owner explicitly authorizes clearing the attempt." };
    }
  }
  try {
    // A question answer is already visible in the group; a time decision still needs its booking result.
    if (!alreadyVisible) await send(request.chatUid!, text);
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
    ...(inGroup ? { silent: true } : {}) };
}
