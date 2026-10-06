// Reject incomplete inspections before calendar work, so the model can repair
// its arguments instead of repeating an opaque tool failure. Omitted candidates
// are left to the tool, which can recover the latest busy-time check.
export function movablePolicy(event) {
  if (event.toolName !== "meetly_movable") return undefined;
  const args = event.params ?? {};
  let error;
  if (args.action !== "inspect") {
    error = "Set action to inspect. Supply one or two {start, end} candidates, or inspect the latest busy time just checked.";
  } else if (args.candidates === undefined) {
    return undefined;
  } else if (!Array.isArray(args.candidates) || args.candidates.length < 1 || args.candidates.length > 2) {
    error = "inspect needs candidates: one or two {start, end} times, such as the busy slot just checked. Call it again with them.";
  } else if (args.candidates.some(slot => !slot || !Number.isFinite(Date.parse(slot.start)) || !(Date.parse(slot.end) > Date.parse(slot.start)))) {
    error = "each candidate needs an ISO start and a later ISO end. Call inspect again with valid times.";
  }
  return error ? { block: true, blockReason: JSON.stringify({ error, code: "INVALID_ARGUMENTS" }) } : undefined;
}
