// A run whose model ended on the silent reply chose to say nothing (it may
// already have sent with the message tool). OpenClaw can still synthesize a
// final for such a run, e.g. "The tool run finished, but no final summary was
// produced…"; that payload must not reach the chat.
const KEEP_MS = 10 * 60_000;

// OpenClaw's own silent-reply test, loaded once from the runtime at startup.
let sdkSilent;
import("openclaw/plugin-sdk/reply-runtime").then(sdk => { sdkSilent = sdk.isSilentReplyText; }, () => {});

function finalText(messages) {
  const last = [...(messages ?? [])].reverse().find(m => m?.role === "assistant");
  if (!last) return undefined;
  return typeof last.content === "string" ? last.content
    : (last.content ?? []).filter(c => c?.type === "text").map(c => c.text).join("");
}

export function createSilentRuns(isSilent = text => sdkSilent?.(text) === true, now = Date.now) {
  const runs = new Map();
  return {
    end(event) {
      for (const [id, at] of runs) if (now() - at > KEEP_MS) runs.delete(id);
      if (!event?.runId) return;
      const text = finalText(event.messages);
      if (text !== undefined && isSilent(text)) runs.set(event.runId, now());
      else runs.delete(event.runId);
    },
    /** Cancels a non-error final of a run that ended silent. */
    sending(event) {
      if (event?.kind !== "final" || event.payload?.isError === true || !runs.has(event.runId)) return undefined;
      return { cancel: true, reason: "the run ended on the silent reply" };
    },
  };
}

export const silentRuns = globalThis[Symbol.for("meetly.silent-runs")] ??= createSilentRuns();
