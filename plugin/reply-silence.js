// Silence applies only to dispatcher reply payloads from the same active run.
// Tool-driven sends, including an owner's DM answer, use a separate delivery path.
export function createReplySilencer() {
  const turns = new Map();
  return {
    begin(ctx) {
      if (ctx.channel !== "plow" || (ctx.accountId ?? "chat") !== "chat" || !ctx.sessionKey?.includes(":plow:group:")) return;
      if (ctx.runId && turns.get(ctx.sessionKey)?.runId === ctx.runId) return;
      turns.set(ctx.sessionKey, { runId: ctx.runId, silent: false });
    },
    afterTool(event, ctx) {
      const turn = turns.get(ctx.sessionKey);
      if (!turn || !event.toolName?.startsWith("meetly_") || event.result?.details?.silent !== true) return;
      const runId = event.runId ?? ctx.runId;
      if (turn.runId && runId !== turn.runId) return;
      turn.silent = true;
    },
    sending(event, ctx) {
      if ((event.channel ?? ctx.channelId) !== "plow" || (ctx.accountId ?? "chat") !== "chat") return;
      const turn = turns.get(event.sessionKey);
      if (!turn?.silent || !event.runId || event.runId !== turn.runId) return;
      return { cancel: true, reason: "Meetly tool requested a silent group turn" };
    },
    endTurn(_event, ctx) {
      if (turns.get(ctx.sessionKey)?.runId === ctx.runId) turns.delete(ctx.sessionKey);
    },
    end(_event, ctx) { turns.delete(ctx.sessionKey); },
  };
}
