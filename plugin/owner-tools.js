import { cleanArgs, constraints, sendPlowMessage } from "./guest-tools.js";

const run = async (context, args, send) => {
  const { answerOwner } = await import("/opt/plow/skills/meetly/scripts/answer-owner.ts");
  return answerOwner(context, args, send);
};

export function registerOwnerTools(api, execute = run, outbound) {
  const required = ["requestId", "askedAt", "text"];
  api.registerTool(context => ({
    name: "meetly_answer_owner", label: "Answer a meeting question",
    description: "Resolve a pending meeting question or time approval from the owner's own answer. First match ledger.ts pending by person and topic. Pass its requestId and pending askedAt, and text as Meetly relaying the answer. From the owner's main DM, sends once to the recorded group and clears after confirmed delivery; never send separately or retry unknown delivery. For a question in that same group, the owner's answer is already visible: clears without sending, then acknowledge briefly. When silent is true, end the turn without a group reply. Owner only. For time approvals, first finish the calendar booking or alternative-time flow, then call this tool with the result; it sends the result once even in the group and clears the approval.",
    parameters: {
      type: "object", additionalProperties: false, required,
      properties: {
        requestId: { type: "string", description: "The matched request's id." },
        askedAt: { type: "string", description: "The matched pending question or time approval's askedAt." },
        text: { type: "string", description: "The owner's answer, phrased as Meetly for the group." },
      },
    },
    async execute(_id, args) {
      const result = await execute(context, cleanArgs(args, required), (to, text) => sendPlowMessage(api, context, to, text, "group", outbound));
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}

const runGroup = async (context, args) => {
  const { offerOwnerGroup } = await import("/opt/plow/skills/meetly/scripts/owner-group.ts");
  return offerOwnerGroup(context, args);
};

export function registerOwnerGroupTool(api, execute = runGroup) {
  const required = ["topic"];
  const string = { type: "string" };
  api.registerTool(context => ({
    name: "meetly_offer_owner_group", label: "Offer times in the owner's group",
    description: "Offer times for the owner's scheduling request in the current group. Uses the normal calendar offer flow; resolves the sole non-owner member and chat from Plow participants. Read meetly-group. Supply the owner's scheduling conditions; this tool searches the calendar and holds times itself. Never supply intervals, guest identity or calendar IDs. If preferencesUnavailable is true, explain that the preferred times do not work and offer the returned alternatives. Reply here using the returned askDetails flag. Owner only.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      topic: string, durationMin: { type: "integer", minimum: 1, description: "Only when explicitly specified; otherwise uses the configured duration." },
      constraints, proposed: constraints, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string,
    } },
    async execute(_id, args) {
      const result = await execute(context, cleanArgs(args, required));
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
