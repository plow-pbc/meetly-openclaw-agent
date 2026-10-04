import { cleanArgs, constraints, sendPlowMessage } from "./guest-tools.js";

const run = async (context, args, send) => {
  const { answerOwner } = await import("/opt/plow/skills/meetly/scripts/answer-owner.ts");
  return answerOwner(context, args, send);
};

export function registerOwnerTools(api, execute = run, outbound) {
  const required = ["requestId", "askedAt", "text"];
  api.registerTool(context => ({
    name: "meetly_answer_owner", label: "Answer a meeting question",
    description: "Resolve a pending meeting question or time approval from the owner's own answer. First match ledger.ts pending by person and topic. Pass its requestId and pending askedAt, and text as Meetly relaying the answer. From the owner's main DM, sends once to the recorded group and clears after confirmed delivery; never send separately or retry unknown delivery. For a question in that same group, the owner's answer is already visible: clears silently without sending or acknowledging. When silent is true, output nothing: no group reply, commentary or \"(Silent — …)\" note. Owner only. For time approvals, first run calendar.ts approve-time: a yes never authorizes overlap. If busy, tell the owner privately and offer nearest free alternatives without conflict titles, then call this tool with the result; it sends the result once even in the group and clears the approval.",
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
    description: "Group-only: never use in the owner's DM. In the owner's DM, follow meetly-group, Owner request: find times, save with calendar.ts offer, then plow_start_thread through the delivery steps. Use this tool only for the owner's scheduling ask in an existing group with exactly one guest and Meetly. Read meetly-group. Supply the owner's scheduling conditions; this tool searches the calendar and holds times itself. Never supply intervals. If preferencesUnavailable is true, explain that the preferred times do not work and offer the returned alternatives. Records the request with this turn's exact chat uid and creates holds through the calendar writer. Resolves the sole guest and chat from Plow participants; never supply guest handles or calendar IDs. Supply name only as the guest's name given by the owner in this thread. Duration comes from the saved request, meal or config. Suggested dates belong in proposed; constraints contain only explicit must/only conditions. Reply with the returned offer here; never open another thread. Greet the guest, never the owner; use a neutral greeting when the guest name is unavailable. Keep owner-only coordination in the DM. If this is your first reply in this group, introduce yourself as \"<agentName>, <ownerName>'s scheduling assistant\" in their language with the offer. Ask format/place only when askDetails is true. Owner only.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      topic: string, meal: { type: "string", enum: ["lunch", "dinner", "coffee"] }, name: { type: "string", description: "Guest name explicitly given by the owner in this thread, if known." },
      constraints: { ...constraints, description: "Only explicit non-relaxable owner conditions, such as must or only. Omit for a suggested date." },
      proposed: { ...constraints, description: "Preferred dates/times from the owner; these may be relaxed when busy." }, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string,
    } },
    async execute(_id, args) {
      const result = await execute(context, cleanArgs(args, required));
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
