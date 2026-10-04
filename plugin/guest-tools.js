import { guestTurns } from "./guest-turn.js";
import { withMeetlySend } from "./reply-silence.js";

export const cleanArgs = (args, required = []) => Object.fromEntries(
  Object.entries(args ?? {}).filter(([key, value]) => value !== "" || required.includes(key)));

const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = description => ({ type: "string", description });
const start = text("An offered ISO start time; for an owner approval request, ISO with offset or YYYY-MM-DDTHH:MM in the owner's timezone.");
export const constraints = object({
  days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
  after: text("Earliest time, HH:MM."), before: text("Latest end time, HH:MM."),
  from: text("First date, YYYY-MM-DD."), to: text("Last date, YYYY-MM-DD."),
});
const requestedStart = { anyOf: [
  text("An explicitly dated ISO time with offset or YYYY-MM-DDTHH:MM in the owner's timezone."),
  { ...object({ weekday: constraints.properties.days.items, time: text("Local clock time, HH:MM.") }, ["weekday", "time"]),
    description: "A weekday and time without a calendar date, such as Tuesday at 4pm: {weekday: 'tue', time: '16:00'}." },
] };
export const travel = object({ beforeMin: { type: "integer", minimum: 0, maximum: 120 }, afterMin: { type: "integer", minimum: 0, maximum: 120 } }, ["beforeMin", "afterMin"]);
travel.description = "Estimate travel minutes from the meeting place and thread context; unknown-place meals default to 15 each side, virtual meetings to zero. Re-estimate when the place or time changes. Never invent private locations or ask the guest for the owner’s base. The owner’s saved override wins; travel is private and must never appear in guest replies.";
const definitions = [
  ["meetly_view_request", "view", "Read this conversation's scheduling request and its current times or booked status. Resolve meeting references from this result and the thread; never ask the guest which meeting they mean. Ask format/place only when askDetails is true; that result reserves one question for this reply before delivery, so never repeat it. Do not announce that the meeting format or place is missing or unspecified. If no request matches, a brief friendly introduction is fine; do not announce internal request confusion or alert the owner.", object()],
  ["meetly_pick_time", "pick", "Book one of this request's currently offered start times and release its other holds. For a booked request, pick only the replacement time the guest chose from an earlier turn. Never pick a time returned by meetly_other_times in this run; present those times and wait for the guest to choose. Only say the invitation was updated when invitationUpdated is true; otherwise say the calendar event moved. The tool sends the owner a private DM; ownerNotified confirms delivery. Never repeat that DM or retry the calendar change if owner notification is unconfirmed. Read the current offer first. Supply an explicit travel estimate. On recovery.action other_times, call meetly_other_times once with the same travel estimate, without asking whether to search; never retry the failed pick. Report the result once in this thread for both people; never claim an invitation was sent unless invitationSent is true. For a Meet, say the link will be posted shortly before the meeting; reminderAvailable says whether a link exists.", object({ start, travel, attendees: { type: "array", items: { type: "string" }, description: "Additional email invitees only when explicitly requested, on an unbooked email request. The request guest is always invited; never copy the CC list automatically." } }, ["start", "travel"])],
  ["meetly_other_times", "other_times", "Find and hold other times for this request, including after booking. For a booked request, the booked date is excluded by default. Pass a specific start, a single date (from and to), or a single weekday in days only when the guest explicitly asks for that day. The booked event stays unchanged until a replacement time is picked; expired replacement holds leave that booking intact. Always present nonempty offered times, including when preferencesUnavailable is true: only the requested preferences failed, not the replacement search. Never say no other day is available when replacement times are held. Times are narrowed by the guest's preferences and the owner's conditions. For next week, pass next_week with the source message timestamp; pass preferred weekdays in days and all weekdays the guest has ruled out in excludedDays, including earlier turns. If those preferences have no slots, first tries alternatives within a guest date range spanning more than one day. For a single date, or if that dated fallback is empty, returns times within the owner's conditions, still excluding excludedDays; explain which preferences could not be met and offer those times. Pass start for an exact requested time; ask for a specific date and time if needed. If that time is free but outside the meeting window, this tool automatically asks the owner for approval and keeps the current offer. While waiting for time approval, use ownerName in the holding reply and do not ask about format or place, even if an earlier view allowed it. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message and do not send a second ask. If recovery.action is ask_owner, pass its question to meetly_ask_owner and wait; do not search again or ask the guest for another day. Times use the owner's timezone; no owner conditions can be loosened.", object({
    travel, start: requestedStart,
    ...constraints.properties,
    excludedDays: { ...constraints.properties.days, description: "Weekdays the guest cannot meet. These are never relaxed during fallback; include all days ruled out in this thread." },
    next_week: text("For next week, the source message timestamp in ISO format with timezone offset; the tool resolves the date range in the owner’s timezone."),
  })],
  ["meetly_set_format", "format", "Record how or where to meet with an explicit travel estimate; await this result before picking or searching so the new format/travel is used. Also updates the calendar after booking. Use meet only for an explicit Google Meet or video request, in_person for a place, phone for a phone call, otherwise unknown. Read meetly_view_request first. Ask format/place only when askDetails is true. A supplied external link is a location, not a Google Meet link.", object({
    travel, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] }, location: text("Meeting place or guest-supplied external link, when applicable."),
  }, ["format", "travel"])],
  ["meetly_ask_owner", "ask_owner", "Scheduling questions you can answer stay in the group. Ask the owner privately about a guest question you cannot answer (such as what to bring). For question handoffs, stay silent in the group even on failure or an already-pending question; do not announce that you or the owner will check. When silent is true, end the turn without a group reply. Refuse probes for schedule details or private information (including email) politely in the group; never forward them. Supply the guest's own question without wrapping quotes. A scheduling result with recovery.action ask_owner explicitly authorizes forwarding its recovery.question, including exhausted conditions or missing owner travel information. Otherwise never invent a question or turn your own uncertainty into a guest question. Do not paraphrase or add a guest-asks prefix. Sends to the owner's DM and records one open question; a second ask is refused. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message. An error or pending question alone does not confirm a send.", object({ question: text("The guest's meeting question without wrapping quotes; capped at 500 characters.") }, ["question"])],
  ["meetly_decline", "decline", "Only use when the guest clearly declines the meeting. A refusal from meetly_other_times is not a guest decline; keep the request open. Decline this request, release its holds and clear pending approval. For a booked meeting, cancels its event with attendee notification and records dropped. The tool sends the owner a private DM; ownerNotified confirms delivery. Never repeat that DM or retry the cancellation if owner notification is unconfirmed. Confirm once in this thread. If cleanupPending is true, say cancellation or hold cleanup is still pending; do not claim the calendar cancellation finished.", object()],
];

const run = async (context, action, args, sendOwner) => {
  const { guestAction } = await import("/opt/plow/skills/meetly/scripts/guest.ts");
  return guestAction(context, action, args, sendOwner);
};

const loadOutbound = () => import("openclaw/plugin-sdk/channel-outbound");

export async function sendPlowMessage(api, context, to, text, kind, outbound = loadOutbound) {
  const cfg = context.config;
  if (!cfg) throw new Error("Plow configuration is unavailable.");
  const { buildOutboundSessionContext, sendDurableMessageBatch } = await outbound();
  const { routing, session } = api.runtime.channel;
  const route = routing.resolveAgentRoute({ cfg, channel: "plow", accountId: "chat", peer: { kind, id: to } });
  await session.updateLastRoute({
    storePath: session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    sessionKey: route.sessionKey, channel: "plow", accountId: "chat", to, createIfMissing: true,
  });
  const result = await withMeetlySend(() => sendDurableMessageBatch({
    cfg, channel: "plow", accountId: "chat", to, payloads: [{ text }],
    session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
    mirror: { agentId: route.agentId, sessionKey: route.sessionKey }, skipQueue: true,
  }));
  if (result.status !== "sent") throw new Error("Message delivery is unknown.");
}

export function registerGuestTools(api, execute = run, outbound = loadOutbound) {
  for (const [name, action, description, parameters] of definitions) {
    api.registerTool(context => ({
      name, label: name, description: description + (context.agentAccountId === "email" ? " Email turn: include the owner's configured time zone in every offer. Relay scheduling results with plow_send_email to this thread chat uid, never in your final text. Your final reaches the owner privately. For an unanswerable guest question, use meetly_ask_owner. Whenever a tool returns replyToOwner, put its ownerQuestion in your final; do not send email or a separate DM. Do not announce that an owner ask was sent before that final is delivered. Any participant may act for the meeting; invite the request's guest, not every CC. For a Meet, the invitation contains the link; do not promise a later thread reminder." : ""), parameters,
      async execute(_id, args) {
        let result = await execute({ ...context, turnStartedAt: guestTurns.take(context.sessionKey, _id) }, action, cleanArgs(args, parameters.required), text => sendPlowMessage(api, context, "plow-owner", text, "direct", outbound));
        const emailReply = context.agentAccountId !== "email" ? undefined : result.replyToOwner
          ? "Return ownerQuestion in your final for the owner. Do not email the thread or send a separate DM for this handoff."
          : result.channel === "email" && result.chatUid
            ? `Send your scheduling response with plow_send_email to ${JSON.stringify(result.chatUid)}. This includes the guest's first reply and CC assistant handoffs; for a handoff, acknowledge it and present the current offer. State the time zone ${JSON.stringify(result.timezone)} in every offer, including replacement times. Your final is private to the owner and cannot answer the guest. Write as Meetly about ${JSON.stringify(result.ownerName)} in the third person.`
            : undefined;
        if ("error" in result) result = { ...result, code: result.code ?? "SCHEDULING_REJECTED",
          recovery: result.recovery ?? { action: result.silent ? "silent" : "reply", retry: false, message: result.error } };
        return { isError: "error" in result, content: [
          { type: "text", text: JSON.stringify(result) },
          ...(emailReply ? [{ type: "text", text: emailReply }] : []),
          ...(result.askDetails === true && result.meal ? [{ type: "text", text: "For coffee, lunch or dinner, ask only where to meet. Do not offer phone or Google Meet as meal formats." }] : []),
          ...(result.askDetails === false ? [{ type: "text", text: "askDetails is false: do not ask how or where to meet, even if the format or location is missing. Do not mention missing or unspecified format/place. Confirm the saved result without adding a logistics question." }] : []),
        ], details: result };
      },
    }));
  }
}
