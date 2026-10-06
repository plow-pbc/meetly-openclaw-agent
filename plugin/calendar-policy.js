// Model-issued writes must use the ledger-backed calendar seam. Its internal
// bridge calls are not model tool calls and do not pass through this hook.
const reads = new Set(["calendars", "events", "event", "list", "ls", "freebusy", "conflicts"]);
const blocked = { block: true, blockReason: "Calendar writes must use calendar.ts with a scheduling request. Use calendar reads for diagnosis; never create test events." };

export function calendarPolicy(event) {
  const tool = event.toolName.split("__").at(-1);
  if (tool === "plow_run_applescript" || (tool === "plow_run_command" && event.params?.apple_events === true)) return blocked;
  const argv = event.params?.argv;
  if (tool !== "plow_run_command" || !Array.isArray(argv) || !["plow-gog", "gog"].includes(argv[0])) return;
  // Latch accepts account selectors anywhere, including attached short forms.
  // Unknown flag layouts fail closed when they contain a calendar group.
  const args = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--account" || arg === "-a") { i++; continue; }
    if (typeof arg === "string" && (arg.startsWith("--account=") || arg.startsWith("-a"))) continue;
    if (["--json", "-j", "--confirm-conflict"].includes(arg)) continue;
    args.push(arg);
  }
  if (["gmail", "mail", "email", "accounts"].includes(args[0])) return;
  if (args.some(arg => arg === "calendar" || arg === "cal")
    && (!["calendar", "cal"].includes(args[0]) || !reads.has(args[1]))) return blocked;
}
