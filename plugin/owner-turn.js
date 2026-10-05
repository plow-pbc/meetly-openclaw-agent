// A group tool may be called again to correct a name or retry. Reserve its
// private handoff before sending, and share even a failed attempt for this run.
export function createOwnerTurns() {
  const runs = new Map();
  const calls = new Map();
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && !runs.has(ctx.runId)) {
        runs.set(ctx.runId, { sessionKey: ctx.sessionKey });
      }
    },
    beforeTool(event, ctx) {
      if (event.toolName !== "meetly_offer_owner_group") return;
      const runId = ctx.runId ?? event.runId;
      const run = runs.get(runId);
      const id = ctx.toolCallId ?? event.toolCallId;
      if (id && run && run.sessionKey === ctx.sessionKey) calls.set(id, runId);
    },
    async sendOnce(sessionKey, id, send) {
      const run = runs.get(calls.get(id));
      if (!run || run.sessionKey !== sessionKey) throw new Error("Owner turn context unavailable");
      run.attempt ??= Promise.resolve().then(send);
      await run.attempt;
    },
    finish(id) { calls.delete(id); },
    end(_event, ctx) {
      runs.delete(ctx.runId);
      for (const [id, runId] of calls) if (runId === ctx.runId) calls.delete(id);
    },
  };
}
export const ownerTurns = globalThis[Symbol.for("meetly.owner-turns")] ??= createOwnerTurns();
