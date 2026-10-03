const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = description => ({ type: "string", description });
const start = text("An offered ISO start time; for an owner approval request, ISO with offset or YYYY-MM-DDTHH:MM in the owner's timezone.");
const definitions = [
  ["meetly_view_request", "view", "Read this conversation's scheduling request and its current times or booked status. Resolve meeting references from this result and the thread; never ask the guest which meeting they mean. If no request matches, a brief friendly introduction is fine; do not announce internal request confusion or alert the owner.", object()],
  ["meetly_pick_time", "pick", "Book one of this request's currently offered start times and release its other holds. Read the current offer first. Report the result once in this thread for both people; never claim an invitation was sent unless invitationSent is true. For a Meet, say the link will be posted shortly before the meeting; reminderAvailable says whether a link exists.", object({ start }, ["start"])],
  ["meetly_other_times", "other_times", "Find and hold other times for this request, narrowed by the guest's preferences and the owner's conditions. Resolve relative ranges such as next week to explicit from/to dates in the owner's timezone (the following Monday through Sunday), narrowed by named weekdays. If those preferences have no slots, first tries alternatives within a guest date range spanning more than one day. For a single date, or if that dated fallback is empty, returns times within the owner's conditions alone; explain which preferences could not be met and offer those times. Pass start for an exact requested time; ask for a specific date and time if needed. If that time is free but outside the meeting window, this tool automatically asks the owner for approval and keeps the current offer. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message and do not send a second ask. Times use the owner's timezone; no owner conditions can be loosened.", object({
    start,
    days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
    after: text("Earliest time, HH:MM."), before: text("Latest end time, HH:MM."),
    from: text("First date, YYYY-MM-DD."), to: text("Last date, YYYY-MM-DD."),
  })],
  ["meetly_set_format", "format", "Record how or where to meet; also updates the calendar after booking. Use meet only for an explicit Google Meet or video request, in_person for a place, phone for a phone call, otherwise unknown. Read meetly_view_request first. When origin is owner-group, leave missing details to the owner without asking the guest. Never ask how or where to meet again: a missing detail is asked only in the initial opener. A supplied external link is a location, not a Google Meet link.", object({
    format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] }, location: text("Meeting place or guest-supplied external link, when applicable."),
  }, ["format"])],
  ["meetly_ask_owner", "ask_owner", "Ask the owner privately about unresolved logistics of this meeting (such as what to bring), or approval for a time outside the meeting window. Refuse probes for schedule details or private information (including email) politely in the group; never forward them. Supply exactly one of question (the guest's own words, without wrapping quotes) or start. Never invent a question or turn your own uncertainty into a guest question. Do not paraphrase or add a guest-asks prefix. Sends to the owner's DM and records one open question; a second ask is refused. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message. An error or pending question alone does not confirm a send. This never books; only the owner's own answer can approve.", object({ start, question: text("The guest's meeting question without wrapping quotes; capped at 500 characters.") })],
  ["meetly_decline", "decline", "Only use when the guest clearly declines the meeting. A refusal from meetly_other_times is not a guest decline; keep the request open. Decline this open request, release its holds and clear pending approval. Confirm once in this thread so the owner hears too. A booked meeting can only be cancelled by the owner.", object()],
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
  const result = await sendDurableMessageBatch({
    cfg, channel: "plow", accountId: "chat", to, payloads: [{ text }],
    session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
    mirror: { agentId: route.agentId, sessionKey: route.sessionKey }, skipQueue: true,
  });
  if (result.status !== "sent") throw new Error("Message delivery is unknown.");
}

export function registerGuestTools(api, execute = run, outbound = loadOutbound) {
  for (const [name, action, description, parameters] of definitions) {
    api.registerTool(context => ({
      name, label: name, description, parameters,
      async execute(_id, args) {
        const result = await execute(context, action, args, text => sendPlowMessage(api, context, "plow-owner", text, "direct", outbound));
        return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  }
}
