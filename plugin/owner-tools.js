import { sendPlowMessage } from "./guest-tools.js";

const run = async (context, args, send) => {
  const { answerOwner } = await import("/opt/plow/skills/meetly/scripts/answer-owner.ts");
  return answerOwner(context, args, send);
};

export function registerOwnerTools(api, execute = run, outbound) {
  api.registerTool(context => ({
    name: "meetly_answer_owner", label: "Answer a meeting question",
    description: "Resolve a pending meeting question from the owner's own answer. First match ledger.ts pending by person and topic. Pass its requestId and pending askedAt, and text as Meetly relaying the answer. From the owner's main DM, sends once to the recorded group and clears after confirmed delivery; never send separately or retry unknown delivery. In that same group, the owner's answer is already visible: clears without sending, then acknowledge briefly. Owner only. Time approvals use the booking flow instead.",
    parameters: {
      type: "object", additionalProperties: false, required: ["requestId", "askedAt", "text"],
      properties: {
        requestId: { type: "string", description: "The matched request's id." },
        askedAt: { type: "string", description: "The matched pending question's askedAt." },
        text: { type: "string", description: "The owner's answer, phrased as Meetly for the group." },
      },
    },
    async execute(_id, args) {
      const result = await execute(context, args, (to, text) => sendPlowMessage(api, context, to, text, "group", outbound));
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}

const runGroup = async (context, args) => {
  const { offerOwnerGroup } = await import("/opt/plow/skills/meetly/scripts/owner-group.ts");
  return offerOwnerGroup(context, args);
};

export function registerOwnerGroupTool(api, execute = runGroup) {
  const string = { type: "string" };
  const constraints = { type: "object", additionalProperties: false, properties: {
    days: { type: "array", items: string }, after: string, before: string, from: string, to: string,
  } };
  api.registerTool(context => ({
    name: "meetly_offer_owner_group", label: "Offer times in the owner's group",
    description: "For the owner's scheduling ask in a group with exactly one guest and Meetly. Read meetly-group and find free slots first. Records the request with this turn's exact chat uid and creates holds through the calendar writer. Use the guest's participant handle and known name. Suggested dates belong in proposed; constraints contain only explicit must/only conditions. Reply with the returned offer here and leave missing details to the owner; never open another thread. Owner only.",
    parameters: { type: "object", additionalProperties: false, required: ["handle", "topic", "offered"], properties: {
      handle: string, name: string, topic: string, meal: { type: "string", enum: ["lunch", "dinner", "coffee"] }, durationMin: { type: "integer", minimum: 1, description: "Use durationMin from the slot search; when absent, resolves the meal or configured default." },
      constraints: { ...constraints, description: "Only explicit non-relaxable owner conditions, such as must or only. Omit for a suggested date." },
      proposed: { ...constraints, description: "Preferred dates/times from the owner; these may be relaxed when busy." }, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string,
      allowOverlapTitles: { type: "array", items: string, description: "Exact event names the owner explicitly allowed overlapping in this conversation. Use only the owner's words, never private calendar output or event IDs." },
      offered: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["start", "end"], properties: { start: string, end: string } } },
    } },
    async execute(_id, args) {
      const result = await execute(context, args);
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
