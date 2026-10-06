import { test } from "node:test";
import assert from "node:assert/strict";
import { createSilentRuns } from "../plugin/silent-runs.js";

const silent = (text: string) => text.trim() === "NO_REPLY";
const sent = { role: "toolResult", content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }] };

test("a run that ended on the silent reply gets no synthesized final; others are untouched", () => {
  const runs = createSilentRuns(silent);
  runs.end({ runId: "quiet", messages: [sent, { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] }] });
  runs.end({ runId: "spoke", messages: [{ role: "assistant", content: [{ type: "text", text: "Booked for Tue at noon." }] }] });
  const fallback = { text: "The tool run finished, but no final summary was produced. I did not repeat any completed actions." };
  assert.deepEqual(runs.sending({ kind: "final", runId: "quiet", payload: fallback }), { cancel: true, reason: "the run ended on the silent reply" });
  assert.equal(runs.sending({ kind: "final", runId: "spoke", payload: { text: "Booked for Tue at noon." } }), undefined);
  assert.equal(runs.sending({ kind: "block", runId: "quiet", payload: fallback }), undefined, "only the final is synthesized");
  assert.equal(runs.sending({ kind: "final", runId: "quiet", payload: { text: "x", isError: true } }), undefined, "error notices go to plainFailure");
  // A retried attempt that answers clears the silence.
  runs.end({ runId: "quiet", messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }] });
  assert.equal(runs.sending({ kind: "final", runId: "quiet", payload: { text: "Done." } }), undefined);
});

test("silence is forgotten after ten minutes", () => {
  let now = 0;
  const runs = createSilentRuns(silent, () => now);
  runs.end({ runId: "old", messages: [{ role: "assistant", content: "NO_REPLY" }] });
  now = 11 * 60_000;
  runs.end({ runId: "other", messages: [] });
  assert.equal(runs.sending({ kind: "final", runId: "old", payload: { text: "late" } }), undefined);
});
