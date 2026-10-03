// A command on the owner's Mac, through the Latch relay that boot
// bridges to loopback: the MCP tool plow_run_command, with the bridge's own
// per-boot token from the gateway's environment. Undefined when there is no
// bridge, the Mac is not connected, or the command is refused or fails.
export const BRIDGE_URL = "http://127.0.0.1:18790/mcp";

// Where the owner gets Plow Latch, the app that connects their Mac.
export const LATCH_DOWNLOAD_URL = "https://plow.co/download/latch";
export const LATCH_ABOUT_URL = "https://plow.co/latch";

export type BridgeOptions = { fetch?: typeof fetch; url?: string; token?: string };
export type MacCommand = { argv: string[]; readPaths: string[]; goal: string; timeoutMs?: number };

export type MacOutcome = { output: string } | { error: string } | { handle: string };

// Keep explicit failures distinct from unknown delivery for calendar reconciliation.
export async function macOutcome(name: string, args: unknown, opts: BridgeOptions = {}, timeoutMs = 20_000): Promise<MacOutcome | undefined> {
  const token = opts.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN;
  if (!token) return undefined;
  const res = await (opts.fetch ?? fetch)(opts.url ?? BRIDGE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  const body = await res.text();
  const data = body.split("\n").find(line => line.startsWith("data:"));
  const reply = JSON.parse(data ? data.slice(5) : body);
  if (reply.result?.isError) return { error: "Mac command refused or failed" };
  const text = reply.result?.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return undefined;
  let out = JSON.parse(text);
  if (out.status === "ready") out = out.result;
  if (out.status === "pending" && typeof out.handle === "string") return { handle: out.handle };
  if (["denied", "blocked", "failed", "error"].includes(out.status)) return { error: "Mac command refused or failed" };
  if (typeof out.exit_code === "number" && out.exit_code !== 0) return { error: "Mac command failed" };
  if (out.exit_code === 0 && typeof out.output === "string") return { output: out.output };
  return undefined;
}

export async function runOnMacOutcome(command: MacCommand, opts: BridgeOptions = {}): Promise<MacOutcome | undefined> {
  return macOutcome("plow_run_command", { argv: command.argv, read_paths: command.readPaths, goal: command.goal }, opts, command.timeoutMs);
}

export async function runOnMac(command: MacCommand, opts: BridgeOptions = {}): Promise<string | undefined> {
  const result = await runOnMacOutcome(command, opts);
  return result && "output" in result ? result.output : undefined;
}

// Whether the Mac answers at all: `/usr/bin/true` through the bridge.
export async function macConnected(opts: BridgeOptions = {}): Promise<boolean> {
  const output = await runOnMac({
    argv: ["/usr/bin/true"], readPaths: [],
    goal: "Meetly setup: check that your Mac is connected",
  }, opts).catch(() => undefined);
  return output !== undefined;
}
