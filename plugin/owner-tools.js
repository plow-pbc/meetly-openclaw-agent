import { constraints, sendPlowMessage } from "./guest-tools.js";

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
      const cleaned = Object.fromEntries(Object.entries(args ?? {}).filter(([key, value]) => value !== "" || required.includes(key)));
      const result = await execute(context, cleaned, (to, text) => sendPlowMessage(api, context, to, text, "group", outbound));
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}

const runGroup = async (context, args) => {
  const { offerOwnerGroup } = await import("/opt/plow/skills/meetly/scripts/owner-group.ts");
  return offerOwnerGroup(context, args);
};

export function registerOwnerGroupTool(api, execute = runGroup) {
  const required = ["handle", "topic", "offered"];
  const string = { type: "string" };
  api.registerTool(context => ({
    name: "meetly_offer_owner_group", label: "Offer times in the owner's group",
    description: "For the owner's scheduling ask in a group with exactly one guest and Meetly. Read meetly-group and find free slots first. Records the request with this turn's exact chat uid and creates holds through the calendar writer. Use the guest's participant handle and known name, the owner's conditions and the slot results. Reply with the returned offer here; never open another thread. Ask format/place only when askDetails is true. Owner only.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      handle: string, name: string, topic: string, durationMin: { type: "integer", minimum: 1, description: "Only when explicitly specified; otherwise uses the configured duration." },
      constraints, proposed: constraints, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string,
      allowOverlapTitles: { type: "array", items: string, description: "Exact event names the owner explicitly allowed overlapping in this conversation. Use only the owner's words, never private calendar output or event IDs." },
      offered: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["start", "end"], properties: { start: string, end: string } } },
    } },
    async execute(_id, args) {
      const cleaned = Object.fromEntries(Object.entries(args ?? {}).filter(([key, value]) => value !== "" || required.includes(key)));
      const result = await execute(context, cleaned);
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
