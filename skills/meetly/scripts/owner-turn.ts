export type OwnerContext = { messageChannel?: string; agentAccountId?: string; senderIsOwner?: boolean; requesterSenderId?: string;
  sessionKey?: string; nativeChannelId?: string; deliveryContext?: { to?: string } };

export function resolveOwnerChat(ctx: OwnerContext, accounts = ["chat"]): string | undefined {
  if (ctx.messageChannel === "plow" && accounts.includes(ctx.agentAccountId ?? "") && ctx.senderIsOwner === true && ctx.requesterSenderId) {
    return ctx.nativeChannelId ?? ctx.deliveryContext?.to?.replace(/^plow:/, "");
  }
}
