const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = description => ({ type: "string", description });
const start = text("An offered ISO start time; for an owner approval request, ISO with offset or YYYY-MM-DDTHH:MM in the owner's timezone.");
const definitions = [
  ["meetly_view_request", "view", "Read your scheduling request in this conversation and its current times or booked status. If no request matches, say so without alerting the owner.", object()],
  ["meetly_pick_time", "pick", "Book one of this request's currently offered start times and release its other holds. Read the current offer first. Report the result once in this thread for both people; never claim an invitation was sent unless invitationSent is true. For a Meet, say the link will be posted shortly before the meeting; reminderAvailable says whether a link exists.", object({ start }, ["start"])],
  ["meetly_other_times", "other_times", "Find and hold other times for this request, narrowed by the guest's preferences and the owner's conditions. If those preferences have no slots, returns new times within the owner's conditions instead; explain the refusal and offer those times. Times use the owner's timezone; no owner conditions can be loosened.", object({
    days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
    after: text("Earliest time, HH:MM."), before: text("Latest end time, HH:MM."),
    from: text("First date, YYYY-MM-DD."), to: text("Last date, YYYY-MM-DD."),
  })],
  ["meetly_set_format", "format", "Record how or where to meet; also updates the calendar after booking. Use meet only for an explicit Google Meet or video request, in_person for a place, phone for a phone call, otherwise unknown. If format is unknown, or in_person has no place, ask once in the thread. A supplied external link is a location, not a Google Meet link.", object({
    format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] }, location: text("Meeting place or guest-supplied external link, when applicable."),
  }, ["format"])],
  ["meetly_ask_owner", "ask_owner", "Check a time outside the owner's hours and record a pending approval. Ask the owner in this thread using the returned time label, then wait. This never books; only the owner's own turn can approve.", object({ start }, ["start"])],
  ["meetly_decline", "decline", "Only use when the guest clearly declines the meeting. A refusal from meetly_other_times is not a guest decline; keep the request open. Decline this open request, release its holds and clear pending approval. Confirm once in this thread so the owner hears too. A booked meeting can only be cancelled by the owner.", object()],
];

const run = async (context, action, args) => {
  const { guestAction } = await import("/opt/plow/skills/meetly/scripts/guest.ts");
  return guestAction(context, action, args);
};

export function registerGuestTools(api, execute = run) {
  for (const [name, action, description, parameters] of definitions) {
    api.registerTool(context => ({
      name, label: name, description, parameters,
      async execute(_id, args) {
        const cleaned = Object.fromEntries(Object.entries(args ?? {}).filter(([key, value]) => value !== "" || parameters.required.includes(key)));
        const result = await execute(context, action, cleaned);
        return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  }
}
