import { cleanArgs, travel, sendPlowMessage } from "./guest-tools.js";

const run = async (context, args, sendGuest) => {
  const { changeOwnerMeeting } = await import("/opt/plow/skills/meetly/scripts/owner-calendar.ts");
  return changeOwnerMeeting(context, args, undefined, {}, sendGuest);
};

export function registerOwnerCalendarTool(api, execute = run) {
  for (const action of ["travel", "format"]) {
    const required = ["requestId", "travel", ...(action === "format" ? ["format", "confirmation"] : [])];
    api.registerTool(context => ({
      name: `meetly_set_owner_${action}`, label: action === "travel" ? "Correct private travel" : "Change a meeting's format or place",
      description: "Owner main DM only. Read ledger.ts booked or pending first to match the saved request. " + (action === "travel"
        ? "Apply the owner's explicit travel minutes as an override without changing meeting duration. The writer sends the authoritative private note. On silent true finish NO_REPLY without any further message; the runtime suppresses the final, including fallback text."
        : "Apply a meeting format/place change with an explicit travel estimate. Supply format: in_person and location for a new place. A saved owner override wins over your estimate for in-person meetings. effectiveTravel is the committed value and is private. Provide confirmation as a short guest-facing new-format/place message without private travel, date/time or invitation claims. After the write succeeds, this tool sends that message to the saved text group and resolves any pending question. Do not send a separate group message or call meetly_answer_owner again when guestConfirmation.delivered is true. On silent true finish NO_REPLY; the channel suppresses duplicate owner acknowledgments. Email requests still require the returned guestConfirmation steps. Never repeat the private travel note.")
        + " Report failed or uncertain delivery without retrying the calendar change.",
      parameters: { type: "object", additionalProperties: false, required, properties: {
        requestId: { type: "string" }, travel,
        ...(action === "format" ? {
          format: { type: "string", enum: ["meet", "phone", "in_person", "unknown"] },
          confirmation: { type: "string", minLength: 1, description: "Guest-facing confirmation of the new format/place, in their language, referring to the owner in the third person. No private travel details, dates/times or invitation promises. Sent only after the calendar write succeeds." },
          location: { type: "string", description: "Required for in_person: the owner's meeting place. Omitting it rejects the change before any write or send." },
        } : {}),
      } },
      async execute(_id, args) {
        const result = await execute(context, { ...cleanArgs(args, required), action },
          (to, text) => sendPlowMessage(api, context, to, text, "group"));
        return { isError: "error" in result, content: [
          { type: "text", text: JSON.stringify(result) },
          ...(result.guestConfirmation?.tool && !result.error ? [{ type: "text", text: "The calendar changed, but the guest has NOT been told. ownerNotified refers only to the private travel note. Now use guestConfirmation.tool with its returned identifiers and a brief new-format/place confirmation, without travel. Complete that delivery before claiming you told the guest or acknowledging completion in the DM. Do not repeat the calendar change." }] : []),
        ], details: result };
      },
    }));
  }
}
