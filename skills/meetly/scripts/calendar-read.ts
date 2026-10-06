import type { Config } from "./config.ts";
import { parseCalendarObject } from "./event.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";

// Keep account provenance attached to every listing, including failed reads.
export async function calendarListings(config: Pick<Config, "calendars">, range: { from: string; to: string }, options: BridgeOptions = {}) {
  const listings: { account: string; listing?: Record<string, any> }[] = [];
  for (const account of new Set(config.calendars.map(c => c.account))) {
    try {
      const output = await runOnMac({ argv: ["plow-gog", "calendar", "events", "--calendars", config.calendars.filter(c => c.account === account).map(c => c.id).join(","),
        "--account", account, "--from", range.from, "--to", range.to, "--max", "100", "--json"],
        readPaths: [], timeoutMs: 60_000, goal: "Meetly: read the calendar for scheduling" }, options);
      if (output === undefined) throw new Error("calendar unavailable");
      const raw = parseCalendarObject(output) as Record<string, any>;
      if (!Array.isArray(raw.events ?? raw.items)) throw new Error("calendar listing unavailable");
      listings.push({ account, listing: { ...raw, events: (raw.events ?? raw.items).map((event: object) => ({ ...event, account })), items: undefined } });
    } catch { listings.push({ account }); }
  }
  return listings;
}

// Latch wraps fetched text as data. Remove only a complete, matching envelope.
export function eventTitle(summary = ""): string {
  const wrapped = summary.match(/^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"\r\n]+)">>>\r?\nSource: google_api\r?\n---\r?\n([\s\S]*)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/);
  return (wrapped?.[2] ?? summary).trim();
}
