import { cleanArgs, travel } from "./guest-tools.js";

const run = async (context, args) => {
  const { changeOwnerMeeting } = await import("/opt/plow/skills/meetly/scripts/owner-calendar.ts");
  return changeOwnerMeeting(context, args);
};

export function registerOwnerCalendarTool(api, execute = run) {
  for (const action of ["travel", "format"]) {
    const required = ["requestId", "travel", ...(action === "format" ? ["format"] : [])];
    api.registerTool(context => ({
      name: `meetly_set_owner_${action}`, label: action === "travel" ? "Correct private travel" : "Change a meeting's format or place",
      description: "Owner main DM only. Read ledger.ts booked or pending first to match the saved request. " + (action === "travel"
        ? "Apply the owner's explicit travel minutes as an override without changing meeting duration. The writer sends the authoritative private note. On silent true finish NO_REPLY without any further message; the runtime suppresses the final, including fallback text."
        : "Apply a meeting format/place change with an explicit travel estimate. Supply format: in_person and location for a new place. A saved owner override wins over your estimate for in-person meetings. effectiveTravel is the committed value and is private. The private owner note does not confirm the change to the guest: follow guestConfirmation after this tool succeeds, without travel details. Never repeat the private travel note or quote your input estimate in the follow-up.")
        + " Report failed or uncertain delivery without retrying the calendar change.",
      parameters: { type: "object", additionalProperties: false, required, properties: {
        requestId: { type: "string" }, travel,
        ...(action === "format" ? {
          format: { type: "string", enum: ["meet", "phone", "in_person", "unknown"] },
          location: { type: "string", description: "The owner's new meeting place, for a place change." },
        } : {}),
      } },
      async execute(_id, args) {
        const result = await execute(context, { ...cleanArgs(args, required), action });
        return { isError: "error" in result, content: [
          { type: "text", text: JSON.stringify(result) },
          ...(result.guestConfirmation ? [{ type: "text", text: "The calendar changed, but the guest has NOT been told. ownerNotified refers only to the private travel note. Now use guestConfirmation.tool with its returned identifiers and a brief new-format/place confirmation, without travel. Complete that delivery before claiming you told the guest or acknowledging completion in the DM. Do not repeat the calendar change." }] : []),
        ], details: result };
      },
    }));
  }
}
