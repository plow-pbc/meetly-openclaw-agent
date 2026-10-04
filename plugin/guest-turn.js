// Tool factories do not receive a run id. Bind the host's tool-call id to the
// first prompt build so retries and prompt rebuilds cannot advance the boundary.
export function createGuestTurns() {
  const runs = new Map();
  const calls = new Map();
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && !runs.has(ctx.runId)) {
        runs.set(ctx.runId, { sessionKey: ctx.sessionKey, startedAt: Date.now() });
      }
    },
    beforeTool(event, ctx) {
      if (event.toolName !== "meetly_pick_time") return;
      const runId = ctx.runId ?? event.runId;
      const run = runs.get(runId);
      const id = ctx.toolCallId ?? event.toolCallId;
      if (id && run && run.sessionKey === ctx.sessionKey) calls.set(id, { ...run, runId });
    },
    take(sessionKey, id) {
      const call = calls.get(id);
      calls.delete(id);
      return call && call.sessionKey === sessionKey ? call.startedAt : undefined;
    },
    end(_event, ctx) {
      runs.delete(ctx.runId);
      for (const [id, call] of calls) if (call.runId === ctx.runId) calls.delete(id);
    },
  };
}
export const guestTurns = globalThis[Symbol.for("meetly.guest-turns")] ??= createGuestTurns();
