// Silence applies only to outgoing messages from the same active run.
// A later owner answer can target this group from a different run or no run.
export function createReplySilencer() {
  const turns = new Map();
  const target = value => typeof value === "string" ? value.replace(/^plow:/, "").toLowerCase() : undefined;
  return {
    begin(ctx) {
      if (ctx.channel !== "plow" || (ctx.accountId ?? "chat") !== "chat" || !ctx.sessionKey?.includes(":plow:group:")) return;
      if (ctx.runId && turns.get(ctx.sessionKey)?.runId === ctx.runId) return;
      turns.set(ctx.sessionKey, { runId: ctx.runId, to: target(ctx.chatId ?? ctx.channelId), silent: false });
    },
    afterTool(event, ctx) {
      const turn = turns.get(ctx.sessionKey);
      if (!turn || !event.toolName?.startsWith("meetly_") || event.result?.details?.silent !== true) return;
      const runId = event.runId ?? ctx.runId;
      if (turn.runId && runId !== turn.runId) return;
      turn.silent = true;
    },
    sending(event, ctx) {
      if (ctx.channelId !== "plow" || (ctx.accountId ?? "chat") !== "chat") return;
      const turn = turns.get(ctx.sessionKey);
      if (!turn?.silent || !turn.to || target(event.to) !== turn.to) return;
      if (!ctx.runId || ctx.runId !== turn.runId) return;
      return { cancel: true, cancelReason: "Meetly tool requested a silent group turn" };
    },
    endTurn(_event, ctx) {
      if (turns.get(ctx.sessionKey)?.runId === ctx.runId) turns.delete(ctx.sessionKey);
    },
    end(_event, ctx) { turns.delete(ctx.sessionKey); },
  };
}
