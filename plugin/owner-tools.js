import { cleanArgs, constraints as guestConstraints, sendPlowMessage } from "./guest-tools.js";

const constraints = { ...guestConstraints, properties: { ...guestConstraints.properties,
  startTime: { type: "string", description: "Owner-selected exact clock time, HH:MM." },
} };

const run = async (context, args, send) => {
  const { answerOwner } = await import("/opt/plow/skills/meetly/scripts/answer-owner.ts");
  return answerOwner(context, args, send);
};

export function registerOwnerTools(api, execute = run, outbound) {
  const required = ["requestId", "askedAt", "text"];
  api.registerTool(context => ({
    name: "meetly_answer_owner", label: "Answer a meeting question",
    description: "Resolve a pending meeting question or time approval from the owner's own answer. First match ledger.ts pending by person and topic. For pendingOwner.alternatives, an owner yes runs a fresh alternative search through meetly-group before answering. Preserve saved conditions unless the owner explicitly changes them. Hold new times before relaying the offer; never just relay yes and clear the decision. Set declineAlternatives:true only when the owner refuses new alternatives. Pass its requestId and pending askedAt, and text as Meetly relaying the answer. From the owner's main DM, sends once to the recorded group and clears after confirmed delivery; never send separately or retry unknown delivery. For a question in that same group, the owner's answer is already visible: clears silently without sending or acknowledging. When silent is true, output nothing: no group reply, commentary or \"(Silent — …)\" note. Owner only. For time approvals, first finish the calendar booking or alternative-time flow, then call this tool with the result; it sends the result once even in the group and clears the approval.",
    parameters: {
      type: "object", additionalProperties: false, required,
      properties: {
        declineAlternatives: { type: "boolean", description: "True only when the owner refuses the pending alternative-time search." },
        requestId: { type: "string", description: "The matched request's id." },
        askedAt: { type: "string", description: "The matched pending question or time approval's askedAt." },
        text: { type: "string", description: "The owner's answer, phrased as Meetly for the group." },
      },
    },
    async execute(_id, args) {
      const result = await execute(context, cleanArgs(args, required), (to, text) => sendPlowMessage(api, context, to, text, "group", outbound));
      return { isError: "error" in result, content: [
        { type: "text", text: JSON.stringify(result) },
        ...(result.silent ? [{ type: "text", text: "The question is resolved in this group. Finish with exactly NO_REPLY; do not emit a visible silence label or repeat the answer." }] : []),
      ], details: result };
    },
  }));
}

const runGroup = async (context, args) => {
  const { offerOwnerGroup } = await import("/opt/plow/skills/meetly/scripts/owner-group.ts");
  return offerOwnerGroup(context, args);
};

export function registerOwnerGroupTool(api, execute = runGroup) {
  const required = ["topic", "durationMin", "introduction"];
  const string = { type: "string" };
  api.registerTool(context => ({
    name: "meetly_offer_owner_group", label: "Offer times in the owner's group",
    description: "Offer times for the owner's scheduling request in the current group. Uses the normal calendar offer flow; resolves the sole non-owner member and chat from Plow participants. Read meetly-group. For this/next week supply week, not computed dates. For earliest available starts supply asap:true. Supply the owner's scheduling conditions; this tool searches the calendar and holds times itself. Never supply intervals, guest handles or calendar IDs. Supply name only as the guest's name given by the owner in this thread; participants determine identity. Choose durationMin from the meeting context and supply it when saving the request. Preserve the saved duration unless the owner requests a change. If preferencesUnavailable is true, explain that the preferred times do not work and offer the returned alternatives. Reply here using the returned askDetails flag. If this is your first reply in this group, introduce yourself as \"<agentName>, <ownerName>'s scheduling assistant\" in their language with the offer. An earlier introduction-only reply already counts; after that, give just the offer without introducing yourself again. Owner only.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      introduction: { type: "string", enum: ["needed", "already_introduced"], description: "Read prior assistant messages. An earlier introduction-only reply counts; choose needed only when no introduction has been given here." },
      week: { type: "string", enum: ["this", "next"] },
      asap: { type: "boolean" },
      durationMin: { type: "integer", minimum: 1, description: "Your chosen meeting duration in minutes, recorded on the request." },
      topic: string, meal: { type: "string", enum: ["lunch", "dinner", "coffee"] }, name: { type: "string", description: "Guest name explicitly given by the owner in this thread, if known." },
      constraints, proposed: constraints, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string,
    } },
    async execute(_id, args) {
      const { introduction, ...request } = cleanArgs(args, required);
      if (!["needed", "already_introduced"].includes(introduction)) {
        return { isError: true, content: [{ type: "text", text: "Choose introduction: needed or already_introduced from this conversation's prior replies before offering times." }] };
      }
      const result = await execute(context, request);
      return { isError: "error" in result, content: [
        { type: "text", text: JSON.stringify(result) },
        ...(!result.error && result.offered?.length ? [{ type: "text", text: introduction === "already_introduced"
          ? "Do not introduce yourself or repeat your role. You already introduced yourself in this conversation. Reply only with the scheduling offer and selection question."
          : "Introduce yourself once as the owner's scheduling assistant, then present the offer and selection question." }] : []),
      ], details: result };
    },
  }));
}

const runDm = async args => {
  const { offerRequest } = await import("/opt/plow/skills/meetly/scripts/calendar.ts");
  return offerRequest(args);
};

export function registerOwnerDmTool(api, execute = runDm) {
  const required = ["origin", "handle", "topic", "offered"];
  const string = { type: "string" };
  api.registerTool(context => ({
    name: "meetly_offer_owner_dm", label: "Offer owner-authorized times",
    description: "Offer times from the owner's main Plow DM. Only pass allowOverlapTitles for events the owner explicitly authorized overlapping in this DM. Resolves titles internally and holds the supplied times through the calendar writer. Read meetly-group. Never call from a group. Uses the saved request duration; for a new request supply meal when applicable (lunch/dinner 60 minutes, coffee 30), otherwise uses the owner's configured duration; rejects mismatched intervals. Save an explicit owner-requested duration on the request first.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      origin: { type: "string", enum: ["owner", "inbound", "owner-group"] }, handle: string, topic: string,
      meal: { type: "string", enum: ["lunch", "dinner", "coffee"] },
      name: string, sourceRowid: { type: "integer" }, chatUid: string,
      constraints, proposed: constraints, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      location: string, locale: string, allowOverlapTitles: { type: "array", items: string },
      offered: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false,
        required: ["start", "end"], properties: { start: string, end: string } } },
    } },
    async execute(_id, args) {
      let result;
      if (context.messageChannel !== "plow" || context.agentAccountId !== "chat" || context.senderIsOwner !== true ||
        !context.requesterSenderId || context.sessionKey !== "agent:main:main") {
        result = { error: "Only the owner's main Plow DM can authorize an overlap offer." };
      } else if ("durationMin" in (args ?? {})) {
        result = { error: "Set durationMin on the saved request, not on meetly_offer_owner_dm." };
      } else {
        try { result = await execute(cleanArgs(args, required)); }
        catch (error) { result = { error: error instanceof Error ? error.message : "The offer could not be completed. Check the request before trying again." }; }
      }
      return { isError: "error" in result, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
