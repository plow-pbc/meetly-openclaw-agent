import { cleanArgs, travel, sendPlowMessage } from "./guest-tools.js";
const run = async (ctx, args, sendGuest, sendOwner) => {
  const { changeOwnerMeeting } = await import("/opt/plow/skills/meetly/scripts/owner-change.ts");
  return changeOwnerMeeting(ctx, args, sendGuest, sendOwner);
};
export function registerOwnerChangeTools(api, execute = run, outbound) {
  for (const action of ["format", "travel"]) {
    const required = action === "format" ? ["requestId", "travel", "format", "confirmation"] : ["requestId", "travel"];
    api.registerTool(context => ({
      name: `meetly_change_${action}`, label: `Change meeting ${action}`,
      description: "Owner main DM only. Read the current meeting first. Applies the existing calendar writer, then delivers the private travel note once. "
        + (action === "format" ? "Delivers confirmation once to the saved guest group and resolves its pending question after delivery. Supply a guest-facing confirmation with no private travel details or invitation promises. An identical format/place/travel without a pending question stays silent. For email, complete returned guestConfirmation steps before acknowledging delivery. " : "Records the owner's explicit travel correction without telling the guest. ")
        + "When silent is true, finish NO_REPLY; do not send a duplicate owner DM. On uncertain delivery report privately without repeating the change or send. effectiveTravel is private.",
      parameters: { type: "object", additionalProperties: false, required, properties: {
        requestId: { type: "string" }, travel,
        ...(action === "format" ? { format: { type: "string", enum: ["meet", "phone", "in_person", "unknown"] },
          location: { type: "string" }, confirmation: { type: "string", minLength: 1 } } : {}),
      } },
      async execute(_id, args) {
        const result = await execute(context, { ...cleanArgs(args, required), action },
          (to, text) => sendPlowMessage(api, context, to, text, "group", outbound),
          text => sendPlowMessage(api, context, "plow-owner", text, "direct", outbound));
        return { isError: "error" in result, details: result, content: [{ type: "text", text: JSON.stringify(result) },
          ...(result.silent ? [{ type: "text", text: "Finish with exactly NO_REPLY after any required guestConfirmation steps. Do not repeat the private owner notice." }] : []),
          ...(result.guestConfirmation?.tool || result.guestConfirmation?.email ? [{ type: "text", text: "Complete guestConfirmation delivery steps before claiming the guest was told. Do not repeat the calendar write or private owner notice." }] : []),
        ] };
      },
    }));
  }
}
