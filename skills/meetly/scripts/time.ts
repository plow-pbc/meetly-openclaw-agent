// Time-zone helpers. All instants are epoch ms; all zones are IANA names.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const DAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type WallParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: Day };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function wallParts(ms: number, tz: string): WallParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    weekday: parts.weekday!.slice(0, 3).toLowerCase() as Day,
  };
}

// The zone's offset from UTC at that instant (local minus UTC).
export function offsetMs(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time in tz happens. The offset is recomputed once
// at the first guess, which is correct across daylight saving changes.
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localIso(ms: number, tz: string): string {
  const p = wallParts(ms, tz);
  const off = Math.round(offsetMs(ms, tz) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function nextWeek(anchor: string, tz: string): { from: string; to: string } {
  const ms = Date.parse(anchor);
  if (!Number.isFinite(ms) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(anchor)) throw new Error("next_week needs an anchor timestamp with a timezone offset");
  const p = wallParts(ms, tz);
  const monday = 7 - DAYS.indexOf(p.weekday);
  const date = (offset: number) => {
    const { y, m, d } = addDays(p.y, p.m, p.d, offset);
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  return { from: date(monday), to: date(monday + 6) };
}

if (isMain(import.meta.url)) run(() => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { anchor: { type: "string" }, timezone: { type: "string" } } });
  if (positionals.length !== 1 || positionals[0] !== "next_week" || !values.anchor || !values.timezone) throw new Error("usage: time.ts next_week --anchor ISO --timezone IANA");
  return nextWeek(values.anchor, values.timezone);
});
