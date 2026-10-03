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

export async function runOnMac(command: MacCommand, opts: BridgeOptions = {}): Promise<string | undefined> {
  const token = opts.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN;
  if (!token) return undefined;
  const res = await (opts.fetch ?? fetch)(opts.url ?? BRIDGE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "plow_run_command", arguments: { argv: command.argv, read_paths: command.readPaths, goal: command.goal } },
    }),
    signal: AbortSignal.timeout(command.timeoutMs ?? 20_000),
  });
  if (!res.ok) return undefined;
  const body = await res.text();
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  const reply = JSON.parse(data ? data.slice(5) : body) as { result?: { isError?: boolean; content?: { type: string; text?: string }[] } };
  if (reply.result?.isError) return undefined;
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  const out = JSON.parse(text) as { exit_code?: number; output?: string };
  if (out.exit_code !== 0 || typeof out.output !== "string") return undefined;
  return out.output;
}

// Whether the Mac answers at all: `/usr/bin/true` through the bridge.
export async function macConnected(opts: BridgeOptions = {}): Promise<boolean> {
  const output = await runOnMac({
    argv: ["/usr/bin/true"], readPaths: [],
    goal: "Meetly setup: check that your Mac is connected",
  }, opts).catch(() => undefined);
  return output !== undefined;
}
