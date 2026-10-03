// Observe actual inbound replies, including acknowledgements that invoke no tool.
const record = async (event, ctx) => {
  const { recordGuestReply } = await import("/opt/plow/skills/meetly/scripts/ledger.ts");
  const { updateJson } = await import("/opt/plow/skills/meetly/scripts/store.ts");
  const { file } = await import("/opt/plow/skills/meetly/scripts/paths.ts");
  updateJson(file("ledger.json"), { requests: [] }, ledger => recordGuestReply(
    ledger, ctx.conversationId, ctx.senderId ?? event.senderId ?? event.from, event.timestamp ?? Date.now(),
  ));
};

export function registerPipelineHooks(api, recordReply = record) {
  api.on("message_received", async (event, ctx) => {
    if (ctx.channelId !== "plow" || ctx.accountId !== "chat" || !ctx.conversationId) return;
    try { await recordReply(event, ctx); }
    catch { api.logger.info("meetly pipeline: could not record guest reply"); }
  });
}
