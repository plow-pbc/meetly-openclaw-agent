// Tool factories do not receive a run id. Bind the host's tool-call id to the
// first prompt build so retries and prompt rebuilds cannot advance the boundary.
export function createGuestTurns() {
  const runs = new Map();
  const calls = new Map();
  return {
    begin(ctx) {
      if (ctx.runId && ctx.sessionKey && !runs.has(ctx.runId)) {
        runs.set(ctx.runId, { sessionKey: ctx.sessionKey });
      }
    },
    beforeTool(event, ctx) {
      if (!["meetly_view_request", "meetly_pick_time", "meetly_other_times", "meetly_set_format", "meetly_ask_owner", "meetly_decline"].includes(event.toolName)) return;
      const runId = ctx.runId ?? event.runId;
      const run = runs.get(runId);
      const id = ctx.toolCallId ?? event.toolCallId;
      if (id && run && run.sessionKey === ctx.sessionKey) calls.set(id, { ...run, runId });
    },
    reply(sessionKey, id, action, result) {
      const call = calls.get(id);
      calls.delete(id);
      const run = call && call.sessionKey === sessionKey ? runs.get(call.runId) : undefined;
      if (!run) return result;
      if (["pick", "other_times", "format", "decline"].includes(action) && !result.error && result.status) {
        run.schedulingResult = result;
      }
      // Silence belongs to the question handoff, not a completed scheduling action.
      if (action === "ask_owner" && result.silent && run.schedulingResult) {
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
