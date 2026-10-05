// Model-issued writes must use the ledger-backed calendar seam. Its internal
// bridge calls are not model tool calls and do not pass through this hook.
export function calendarPolicy(event) {
  const argv = event.params?.argv;
  if ((event.toolName === "plow_run_command" || event.toolName.endsWith("__plow_run_command"))
    && Array.isArray(argv) && argv[0] === "plow-gog" && argv[1] === "calendar"
    && ["create", "update", "delete"].includes(argv[2])) {
    return { block: true, blockReason: "Calendar writes must use calendar.ts with a scheduling request. Use calendar reads for diagnosis; never create test events." };
  }
}
