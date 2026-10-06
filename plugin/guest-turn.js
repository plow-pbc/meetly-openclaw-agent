// The runtime serializes runs within a session. Prompt rebuilds retain the
// current turn's result; a new run starts a fresh scheduling reply boundary.
export function createGuestTurns() {
  const turns = new Map();
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && turns.get(ctx.sessionKey)?.runId !== ctx.runId) {
        turns.set(ctx.sessionKey, { runId: ctx.runId, startedAt: Date.now() });
      }
    },
    async sendOnce(sessionKey, send) {
      const turn = turns.get(sessionKey);
      if (!turn) throw new Error("Owner turn context unavailable");
      turn.attempt ??= Promise.resolve().then(send);
      await turn.attempt;
    },
    take(sessionKey) { return turns.get(sessionKey)?.startedAt; },
    reply(sessionKey, action, result) {
      const turn = turns.get(sessionKey);
      if (!turn) return result;
      if (["pick", "other_times", "format", "decline"].includes(action) && !result.error && result.status) {
        turn.schedulingResult = result;
      }
      // Silence belongs to the question handoff, not a completed scheduling action.
      if (action === "ask_owner" && result.silent && turn.schedulingResult) {
        return { ...result, silent: false, schedulingResult: turn.schedulingResult };
      }
      return result;
    },
    end(_event, ctx) {
      if (turns.get(ctx.sessionKey)?.runId === ctx.runId) turns.delete(ctx.sessionKey);
    },
  };
}
export const guestTurns = globalThis[Symbol.for("meetly.guest-turns")] ??= createGuestTurns();
