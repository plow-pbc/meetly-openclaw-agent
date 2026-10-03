import { AsyncLocalStorage } from "node:async_hooks";

// Only sends initiated by Meetly carry this marker; concurrent dispatcher sends do not.
// OpenClaw registers agent hooks and outbound hooks in separate plugin registries.
const shared = globalThis[Symbol.for("meetly.reply-silence")] ??= { ownSend: new AsyncLocalStorage() };
const ownSend = shared.ownSend;
export const getReplySilencer = () => shared.silencer ??= createReplySilencer();
export const withMeetlySend = send => ownSend.run(true, send);
const destination = to => to?.replace(/^plow:/i, "").toLowerCase();
export function createReplySilencer() {
  const turns = new Map();
  const ended = new Map();
  return {
    begin(ctx) {
      if (ctx.channel !== "plow" || (ctx.accountId ?? "chat") !== "chat" || !ctx.sessionKey?.includes(":plow:group:")) return;
      if (ctx.runId && turns.get(ctx.sessionKey)?.runId === ctx.runId) return;
      ended.delete(ctx.sessionKey);
      turns.set(ctx.sessionKey, { runId: ctx.runId, silent: false,
        to: destination(ctx.chatId ?? ctx.sessionKey.split(":plow:group:")[1]) });
    },
    afterTool(event, ctx) {
      const turn = turns.get(ctx.sessionKey);
      if (!turn || !event.toolName?.startsWith("meetly_") || event.result?.details?.silent !== true) return;
      const runId = event.runId ?? ctx.runId;
      if (turn.runId && runId !== turn.runId) return;
      turn.silent = true;
    },
    sending(event, ctx) {
      if (ctx.channelId !== "plow" || (ctx.accountId ?? "chat") !== "chat" || ownSend.getStore()) return;
      // Outbound session/run context can belong to the sender, so match the destination.
      const to = destination(event.to);
      if (to && [...turns.values()].some(turn => turn.silent && turn.to === to)) {
        return { cancel: true, cancelReason: "Meetly tool requested a silent group turn" };
      }
    },
    sendingReply(event, ctx) {
      if ((event.channel ?? ctx.channelId) !== "plow" || (ctx.accountId ?? "chat") !== "chat") return;
      const turn = turns.get(event.sessionKey) ?? ended.get(event.sessionKey);
      if (turn?.silent && event.runId && event.runId === turn.runId) {
        return { cancel: true, reason: "Meetly tool requested a silent group turn" };
      }
    },
    endTurn(_event, ctx) {
      const turn = turns.get(ctx.sessionKey);
      if (!turn || turn.runId !== ctx.runId) return;
      // The dispatcher may deliver its final after agent_end. Retain only that
      // run's identity; it must no longer silence other sends into the group.
      if (turn.silent && turn.runId) ended.set(ctx.sessionKey, { runId: turn.runId, silent: true });
      turns.delete(ctx.sessionKey);
    },
    end(_event, ctx) { turns.delete(ctx.sessionKey); ended.delete(ctx.sessionKey); },
  };
}
