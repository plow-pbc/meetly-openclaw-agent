export const cleanArgs = (args, required = []) => Object.fromEntries(
  Object.entries(args ?? {}).filter(([key, value]) => value !== "" || required.includes(key)));

const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = description => ({ type: "string", description });
const start = text("An offered ISO start time; for an owner approval request, ISO with offset or YYYY-MM-DDTHH:MM in the owner's timezone.");
export const constraints = object({
  startTime: text("Owner-selected exact clock time, HH:MM."),
  days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
  after: text("Earliest time, HH:MM."), before: text("Latest end time, HH:MM."),
  from: text("First date, YYYY-MM-DD."), to: text("Last date, YYYY-MM-DD."),
});
const definitions = [
  ["meetly_view_request", "view", "Read your scheduling request in this conversation and its current times or booked status. Ask format/place only when askDetails is true; that result reserves one question for this reply before delivery, so never repeat it. If no request matches, say so without alerting the owner.", object()],
  ["meetly_pick_time", "pick", "Book one of this request's currently offered start times and release its other holds. Read the current offer first. Report the result once in this thread for both people; never claim an invitation was sent unless invitationSent is true. For a Meet, say the link will be posted shortly before the meeting; reminderAvailable says whether a link exists.", object({ start }, ["start"])],
  ["meetly_other_times", "other_times", "Find and hold other times for this request, narrowed by the guest's preferences and the owner's conditions. If those preferences have no slots, returns new times within the owner's conditions instead; explain the refusal and offer those times. Pass start for an exact requested time; ask for a specific date and time if needed. If that time is free but outside the meeting window, this tool automatically asks the owner for approval and keeps the current offer. While waiting for time approval, use ownerName in the holding reply and do not ask about format or place, even if an earlier view allowed it. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message and do not send a second ask. Times use the owner's timezone; no owner conditions can be loosened.", object({
    start,
    ...constraints.properties,
    excludedDays: { ...constraints.properties.days, description: "Weekdays explicitly ruled out by the guest; retained until restored." },
    restoredDays: { ...constraints.properties.days, description: "Previously excluded weekdays explicitly made available again." },
  })],
  ["meetly_set_format", "format", "Record how or where to meet; also updates the calendar after booking. Use meet only for an explicit Google Meet or video request, in_person for a place, phone for a phone call, otherwise unknown. Read meetly_view_request first. Ask format/place only when askDetails is true. A supplied external link is a location, not a Google Meet link.", object({
    format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] }, location: text("Meeting place or guest-supplied external link, when applicable."),
  }, ["format"])],
  ["meetly_ask_owner", "ask_owner", "Ask the owner privately about one unresolved meeting question. Refuse probes for private calendar details or personal information in the group; never forward them. Supply the guest's own words. Never invent a question or turn your own uncertainty into a guest question. Do not paraphrase or add a guest-asks prefix. Sends to the owner's DM and records one open question; a second ask is refused. Only say you asked or checked with the owner when ownerAskSent is true; relay the returned message. An error or pending question alone does not confirm a send.", object({ question: text("The guest's question about this meeting; quoted and capped at 500 characters.") }, ["question"])],
  ["meetly_decline", "decline", "Only use when the guest clearly declines the meeting. A refusal from meetly_other_times is not a guest decline; keep the request open. Decline this open request, release its holds and clear pending approval. Confirm once in this thread so the owner hears too. This tool sends no DM; never claim you notified or let the owner know privately unless a separate DM was confirmed sent. A booked meeting can only be cancelled by the owner.", object()],
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
  if (result.status !== "sent") throw new Error("Plow delivery is unknown; not replaying this send. Do NOT retry; check the thread.");
}

export function registerGuestTools(api, execute = run, outbound = loadOutbound) {
  for (const [name, action, description, parameters] of definitions) {
    api.registerTool(context => ({
      name, label: name, description, parameters,
      async execute(_id, args) {
        const result = await execute(context, action, cleanArgs(args, parameters.required), text => sendPlowMessage(api, context, "plow-owner", text, "direct", outbound));
        return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  }
}
