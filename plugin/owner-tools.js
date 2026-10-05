import { ownerTurns } from "./owner-turn.js";
import { cleanArgs, constraints, travel, sendPlowMessage } from "./guest-tools.js";

const run = async (context, args, send) => {
  const { answerOwner } = await import("/opt/plow/skills/meetly/scripts/answer-owner.ts");
  return answerOwner(context, args, send);
};

export function registerOwnerTools(api, execute = run, outbound) {
  const required = ["requestId", "askedAt", "text", "outcome"];
  api.registerTool(context => ({
    name: "meetly_answer_owner", label: "Answer a meeting question",
    description: "Resolve a pending meeting question or time approval from the owner's own answer. First match ledger.ts pending by person and topic. In a group, read ledger.ts find --chat for this chat and call this tool when the owner answers its pending question, even when their answer is already visible. Never substitute a normal reply or silence for clearing the pending question. Pass its requestId and pending askedAt, and text as Meetly relaying the answer. From the owner's main DM, sends once to the recorded group and clears after confirmed delivery; never send separately or retry unknown delivery. Choose outcome=answer for words only, or calendar_change after applying a meeting change through calendar.ts. For a question in that same group, outcome=answer clears silently without sending or acknowledging; calendar_change sends its confirmed result once before clearing. When silent is true, output nothing: no group reply, commentary or \"(Silent — …)\" note. For email, send returned email.to/email.body with plow_send_email, then call again with the same requestId, askedAt, outcome and text plus emailSent:true only after confirmed sent:true. An unknown send remains pending. A question already answered by the owner in the email thread clears without another send. Owner only. For time approvals, first run calendar.ts approve-time: a yes never authorizes overlap. If busy, tell the owner privately and offer nearest free alternatives without conflict titles, then call this tool with the result; it sends the result once even in the group and clears the approval.",
    parameters: {
      type: "object", additionalProperties: false, required,
      properties: {
        outcome: { type: "string", enum: ["answer", "calendar_change"], description: "answer for words only; calendar_change after successfully applying a meeting change. Never include private travel details in text." },
        requestId: { type: "string", description: "The matched request's id." },
        askedAt: { type: "string", description: "The matched pending question or time approval's askedAt." },
        text: { type: "string", description: "The owner's answer, phrased as Meetly for the group." },
        emailSent: { type: "boolean", description: "Only true after plow_send_email confirms sent: true for the email answer returned by this tool. Keep the same requestId, askedAt, outcome and text." },
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

const runGroup = async (context, args, sendOwner) => {
  const { offerOwnerGroup } = await import("/opt/plow/skills/meetly/scripts/owner-group.ts");
  return offerOwnerGroup(context, args, sendOwner);
};

export function registerOwnerGroupTool(api, execute = runGroup, outbound) {
  const required = ["topic", "durationMin", "introduction"];
  const string = { type: "string" };
  api.registerTool(context => ({
    name: "meetly_offer_owner_group", label: "Offer times in the owner's group",
    description: "Group-only: never use in the owner's DM. If silent is true, output nothing in the group and do not send another message or retry: the tool handles private coordination. Offer times for the owner's scheduling request in the current group. Uses the normal calendar offer flow; resolves the sole non-owner member and chat from Plow participants. Read meetly-group. For this/next week supply week, not computed dates. For earliest available starts supply asap:true. Supply explicit travel estimates; read meetly-travel before in-person preparation. Supply the owner's scheduling conditions; this tool searches the calendar and holds times itself. Never supply intervals, guest handles or calendar IDs. Supply name only as the guest's name given by the owner in this thread; participants determine identity. Choose durationMin from the meeting context and supply it when saving the request. Preserve the saved duration unless the owner requests a change. If preferencesUnavailable is true, explain that the preferred times do not work and offer the returned alternatives. Reply here using the returned askDetails flag. If this is your first reply in this group, introduce yourself as \"<agentName>, <ownerName>'s scheduling assistant\" in their language with the offer. An earlier introduction-only reply already counts; after that, give just the offer without introducing yourself again. Owner only.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      introduction: { type: "string", enum: ["needed", "already_introduced"], description: "Read prior assistant messages. An earlier introduction-only reply counts; choose needed only when no introduction has been given here." },
      week: { type: "string", enum: ["this", "next"] },
      asap: { type: "boolean" },
      durationMin: { type: "integer", minimum: 1, description: "Your chosen meeting duration in minutes, recorded on the request." },
      topic: string, meal: { type: "string", enum: ["lunch", "dinner", "coffee"] }, name: { type: "string", description: "Guest name explicitly given by the owner in this thread, if known." },
      constraints: { ...constraints, description: "Explicit non-relaxable owner conditions, including an accepted exact clock time in startTime. Supplied conditions replace the saved conditions; an empty object clears them and omission preserves them." },
      proposed: { ...constraints, description: "Preferred dates/times from the owner; these may be relaxed when busy." }, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      travel, location: string, locale: string,
    } },
    async execute(_id, args) {
      try {
        const { introduction, ...request } = cleanArgs(args, required);
        if (!["needed", "already_introduced"].includes(introduction)) {
          return { isError: true, content: [{ type: "text", text: "Choose introduction: needed or already_introduced from this conversation's prior replies before offering times." }] };
        }
        const result = await execute(context, request, text => ownerTurns.sendOnce(context.sessionKey, _id,
          () => sendPlowMessage(api, context, "plow-owner", text, "direct", outbound)));
        return { isError: "error" in result, content: [
          { type: "text", text: JSON.stringify(result) },
          ...(result.silent ? [{ type: "text", text: "Finish with exactly NO_REPLY. The tool has finished; do not call this tool again to correct names or resend, and do not send another message." }] : []),
          ...(!result.silent && !result.error && result.offered?.length ? [{ type: "text", text: introduction === "already_introduced"
            ? "Do not introduce yourself or repeat your role. You already introduced yourself in this conversation. Reply only with the scheduling offer and selection question."
            : "Introduce yourself once as the owner's scheduling assistant, then present the offer and selection question." }] : []),
        ], details: result };
      } finally { ownerTurns.finish(_id); }
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
    description: "Offer times from the owner's main Plow DM. Only pass allowOverlapTitles for events the owner explicitly authorized overlapping in this DM. Resolves titles internally and holds the supplied times through the calendar writer. Read meetly-group. Never call from a group. Uses the saved request duration or the owner's configured duration for a new request; rejects mismatched intervals. Save an explicit owner-requested duration on the request first.",
    parameters: { type: "object", additionalProperties: false, required, properties: {
      channel: { type: "string", enum: ["text", "email"] },
      meal: { type: "string", enum: ["lunch", "dinner", "coffee"] },
      origin: { type: "string", enum: ["owner", "inbound", "owner-group"] }, handle: string, topic: string,
      name: string, sourceRowid: { type: "integer" }, chatUid: string,
      constraints, proposed: constraints, format: { type: "string", enum: ["meet", "in_person", "phone", "unknown"] },
      travel, location: string, locale: string, allowOverlapTitles: { type: "array", items: string },
      offered: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
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
