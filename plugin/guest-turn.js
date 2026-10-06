// The runtime serializes runs within a session. Prompt rebuilds retain the
// current turn's result; a new run starts a fresh scheduling reply boundary.
export function createGuestTurns() {
  const turns = new Map();
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && turns.get(ctx.sessionKey)?.runId !== ctx.runId) {
        turns.set(ctx.sessionKey, { runId: ctx.runId });
      }
    },
    reply(sessionKey, action, result) {
      const turn = turns.get(sessionKey);
      if (["pick", "other_times", "format", "decline"].includes(action) && !result.error && result.status) {
        if (turn) turn.schedulingResult = result;
        return { ...result, silent: false };
      }
      // Silence belongs to the question handoff, not a completed scheduling action.
      if (action === "ask_owner" && result.silent && turn?.schedulingResult) {
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
