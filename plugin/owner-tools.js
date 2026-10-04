import { sendPlowMessage } from "./guest-tools.js";

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
