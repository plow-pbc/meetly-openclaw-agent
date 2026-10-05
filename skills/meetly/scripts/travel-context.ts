// Location text is untrusted estimate input, never a scheduling instruction.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { parseCalendarObject } from "./event.ts";
import { requestEvents, type Ledger } from "./ledger.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";

export async function travelContext(config: Config, range: { from: string; to: string; start: string; end: string }, id?: string, options: BridgeOptions = {}) {
  const [from, to, start, end] = [range.from, range.to, range.start, range.end].map(Date.parse);
  if (![from, to, start, end].every(Number.isFinite) || !(from! <= start! && start! < end! && end! <= to!)) throw new Error("provide a read range around a valid slot");
  const request = readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === id);
  if (id && !request) throw new Error("unknown request");
  const own = request ? requestEvents(request) : [];
  const nearby: { start: number; end: number; location: string | null }[] = [];
  for (const account of new Set(config.calendars.map(c => c.account))) {
    const output = await runOnMac({ argv: ["plow-gog", "calendar", "events", "--calendars", config.calendars.filter(c => c.account === account).map(c => c.id).join(","),
      "--account", account, "--from", range.from, "--to", range.to, "--all-pages", "--json"],
      readPaths: [], timeoutMs: 60_000, goal: "Meetly: read nearby locations for a private travel estimate" }, options);
    if (output === undefined) throw new Error("calendar unavailable");
    const raw = parseCalendarObject(output) as any;
    if (raw.errors?.length || !Array.isArray(raw.events ?? raw.items)) throw new Error("calendar unavailable");
    for (const event of raw.events ?? raw.items) {
      if (event.status === "cancelled" || event.transparency === "transparent" || own.some(ref => ref.account === account && ref.holdId === event.id)) continue;
      const start = Date.parse(event.start?.dateTime), end = Date.parse(event.end?.dateTime);
      if (Number.isFinite(start) && Number.isFinite(end)) nearby.push({ start, end, location: typeof event.location === "string" ? event.location : null });
    }
  }
  return { before: nearby.filter(e => e.end <= start!).sort((a, b) => b.end - a.end)[0]?.location ?? null,
    after: nearby.filter(e => e.start >= end!).sort((a, b) => a.start - b.start)[0]?.location ?? null };
}

if (isMain(import.meta.url)) run(() => {
  const { values } = parseArgs({ options: Object.fromEntries(["from", "to", "start", "end", "request"].map(key => [key, { type: "string" as const }])) });
  if (!values.from || !values.to || !values.start || !values.end) throw new Error("travel-context.ts needs --from --to --start --end [--request ID]");
  return travelContext(loadConfig(), { from: String(values.from), to: String(values.to), start: String(values.start), end: String(values.end) }, values.request as string | undefined);
});
