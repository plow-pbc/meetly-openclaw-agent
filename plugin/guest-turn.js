// Tool factories have no run id. Bind each host tool-call id to its run so
// prompt rebuilds and another run in the same session cannot move the boundary.
export function createGuestTurns() {
  const runs = new Map();
  const calls = new Map();
  const resolve = (sessionKey, id) => {
    const call = calls.get(id);
    return call && call.sessionKey === sessionKey ? runs.get(call.runId) : undefined;
  };
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && !runs.has(ctx.runId)) {
        runs.set(ctx.runId, { runId: ctx.runId, sessionKey: ctx.sessionKey, startedAt: Date.now() });
      }
    },
    beforeTool(event, ctx) {
      if (!event.toolName?.startsWith("meetly_")) return;
      const runId = ctx.runId ?? event.runId;
      const run = runs.get(runId);
      const id = ctx.toolCallId ?? event.toolCallId;
      if (id && run?.sessionKey === ctx.sessionKey) calls.set(id, { runId, sessionKey: ctx.sessionKey });
    },
    async sendOnce(sessionKey, id, send) {
      const run = resolve(sessionKey, id);
      if (!run) throw new Error("Owner turn context unavailable");
      run.attempt ??= Promise.resolve().then(send);
      await run.attempt;
    },
    take(sessionKey, id) { return resolve(sessionKey, id)?.startedAt; },
    execute(sessionKey, id, execute) {
      const run = resolve(sessionKey, id);
      if (!run) return execute();
      const result = (run.pending ?? Promise.resolve()).then(async () => {
        if (run.terminalReply) return run.terminalReply;
        const result = await execute();
        // A holding reply has already ended the conversation for this run.
        if (result.guestReplyAttempted) run.terminalReply = result;
        return result;
      });
      run.pending = result.then(() => {}, () => {});
      return result;
    },
    reply(sessionKey, id, action, result) {
      const run = resolve(sessionKey, id);
      calls.delete(id);
      if (["pick", "other_times", "format", "decline"].includes(action) && !result.error && result.status && !result.guestReplyAttempted) {
        if (run) run.schedulingResult = result;
        return { ...result, silent: false };
      }
      if (action === "ask_owner" && result.silent && !result.guestReplyAttempted && run?.schedulingResult) {
        return { ...result, silent: false, schedulingResult: run.schedulingResult };
      }
      return result;
    },
    end(_event, ctx) {
      runs.delete(ctx.runId);
      for (const [id, call] of calls) if (call.runId === ctx.runId) calls.delete(id);
    },
  };
}
export const guestTurns = globalThis[Symbol.for("meetly.guest-turns")] ??= createGuestTurns();
