import { sameRequest, recordDelivery, updateRequest, type Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { resolveOwnerChat, type OwnerContext } from "./owner-turn.ts";

type Args = { requestId?: string; askedAt?: string; text?: string; outcome?: "answer" | "calendar_change" };

export async function answerOwner(ctx: OwnerContext, args: Args, send: (to: string, text: string) => Promise<void>): Promise<object> {
  const chat = resolveOwnerChat(ctx);
  if (!chat) {
    return { error: "Only the owner's own Plow turn can answer a meeting question." };
  }
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "Provide the owner's answer." };
  if (!["answer", "calendar_change"].includes(args.outcome ?? "")) return { error: "Choose outcome: answer or calendar_change after a successful calendar write." };
  const path = file("ledger.json");
  const ledger = readJson<Ledger>(path, { requests: [] });
  const request = ledger.requests.find(r => r.id === args.requestId);
  let pending = request?.pendingOwner;
  if (!request?.chatUid || !pending || pending.askedAt !== args.askedAt
    || !["offered", "booked"].includes(request.status)) return { error: "No matching pending meeting question. Read the pending requests again." };
  const inGroup = chat === request.chatUid;
  if (ctx.sessionKey !== "agent:main:main" && !inGroup) {
    return { error: "Answer from the owner's main DM or this request's group." };
  }
  const alreadyVisible = inGroup && "question" in pending && args.outcome === "answer";
  if (!alreadyVisible) {
    try {
      const begun = updateJson<Ledger>(path, { requests: [] }, latest => {
        if (!sameRequest(latest.requests.find(r => r.id === request.id), request)) throw new Error("request changed");
        return recordDelivery(latest, request.id, "answer", "begin", Date.now());
      });
      pending = begun.requests.find(r => r.id === request.id)!.pendingOwner!;
    } catch {
      return { error: "Answer delivery already attempted or request changed. Read pending requests; retry only after the owner explicitly authorizes clearing the attempt." };
    }
  }
  try {
    // The owner's words may be visible, but a calendar change still needs its result delivered.
    if (!alreadyVisible) await send(request.chatUid, args.text.trim());
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
  return { answered: true, sent: !alreadyVisible, requestId: request.id,
    ...(inGroup ? { silent: true } : {}) };
}
