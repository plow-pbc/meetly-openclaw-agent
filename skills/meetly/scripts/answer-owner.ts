import { recordDelivery, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

type Context = { messageChannel?: string; agentAccountId?: string; senderIsOwner?: boolean; requesterSenderId?: string;
  sessionKey?: string; nativeChannelId?: string; deliveryContext?: { to?: string } };
type Args = { requestId?: string; askedAt?: string; text?: string };

export async function answerOwner(ctx: Context, args: Args, send: (to: string, text: string) => Promise<void>): Promise<object> {
  const chat = ctx.nativeChannelId ?? ctx.deliveryContext?.to?.replace(/^plow:/, "");
  if (ctx.messageChannel !== "plow" || ctx.agentAccountId !== "chat" || ctx.senderIsOwner !== true || !ctx.requesterSenderId || !chat) {
    return { error: "Only the owner's own Plow turn can answer a meeting question." };
  }
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "Provide the owner's answer." };
  const path = file("ledger.json");
  const ledger = readJson<Ledger>(path, { requests: [] });
  const request = ledger.requests.find(r => r.id === args.requestId);
  let pending = request?.pendingOwner;
  if (!request?.chatUid || !pending || !("question" in pending) || pending.askedAt !== args.askedAt
    || !["offered", "booked"].includes(request.status)) return { error: "No matching pending meeting question. Read the pending requests again." };
  const inGroup = chat === request.chatUid;
  if (ctx.sessionKey !== "agent:main:main" && !inGroup) {
    return { error: "Answer from the owner's main DM or this request's group." };
  }
  if (!inGroup) {
    try {
      const begun = updateJson<Ledger>(path, { requests: [] }, latest => {
        if (JSON.stringify(latest.requests.find(r => r.id === request.id)) !== JSON.stringify(request)) throw new Error("request changed");
        return recordDelivery(latest, request.id, "answer", "begin", Date.now());
      });
      pending = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
    } catch {
      return { error: "Answer delivery already attempted or request changed. Read pending requests; retry only after the owner explicitly authorizes clearing the attempt." };
    }
  }
  try {
    // In this group, the owner's incoming message already delivered their answer.
    if (!inGroup) await send(request.chatUid, args.text.trim());
  } catch {
    return { error: "Answer delivery is unknown. The question remains pending; do not resend automatically." };
  }
  try {
    updateJson<Ledger>(path, { requests: [] }, latest => {
      const current = latest.requests.find(r => r.id === request.id)?.pendingOwner;
      if (!current || JSON.stringify(current) !== JSON.stringify(pending)) return latest;
      return updateRequest(latest, request.id, { pendingOwner: null }, Date.now());
    });
  } catch {
    return { error: "The answer is in the group, but its pending question could not be cleared. Do not resend; repair the ledger." };
  }
  return { answered: true, sent: !inGroup, requestId: request.id,
    ...(inGroup ? { message: "The owner's answer is already visible here and the question is cleared. Acknowledge briefly." } : {}) };
}
