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

export function formatMeetingTime(start: string, timezone: string, locale = "en-US", now = Date.now()): string {
  const absolute = new Intl.DateTimeFormat(locale, {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(start));
  // Compare calendar dates, not elapsed hours: a local day can have 23 or 25 hours.
  const dateNumber = (ms: number) => Date.parse(`${localIso(ms, timezone).slice(0, 10)}T00:00:00Z`);
  const days = (dateNumber(Date.parse(start)) - dateNumber(now)) / 86_400_000;
  return days === 0 || days === 1
    ? `${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")}, ${absolute}` : absolute;
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

export type WeekdayTime = { weekday: Day; time?: string };
export class WeekdayDateRequired extends Error {
  constructor() { super("Provide a calendar date: that weekday is not unique in the current offer's date window."); }
}

// Bare weekdays belong to the calendar weeks being offered, narrowed by saved date bounds.
export function offerDateWindow(offered: readonly { start: string }[], tz: string, bounds: { from?: string; to?: string } = {}): { from: string; to: string } {
  if (!offered.length) throw new WeekdayDateRequired();
  const mondays = offered.map(({ start }) => {
    const p = wallParts(Date.parse(start), tz);
    return Date.UTC(p.y, p.m - 1, p.d - DAYS.indexOf(p.weekday));
  });
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = [date(Math.min(...mondays)), bounds.from].filter(Boolean).sort().at(-1)!;
  const to = [date(Math.max(...mondays) + 6 * 86_400_000), bounds.to].filter(Boolean).sort()[0]!;
  if (from > to) throw new WeekdayDateRequired();
  return { from, to };
}

export function resolveWeekday(value: WeekdayTime, offered: readonly { start: string }[], tz: string, bounds: { from?: string; to?: string } = {}): string {
  if (!value || !DAYS.includes(value.weekday) || (value.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time))) throw new Error("Invalid weekday or clock time");
  const { from, to } = offerDateWindow(offered, tz, bounds);
  const first = new Date(`${from}T00:00:00Z`);
  const offset = (DAYS.indexOf(value.weekday) - (first.getUTCDay() + 6) % 7 + 7) % 7;
  const candidate = first.getTime() + offset * 86_400_000;
  const date = new Date(candidate).toISOString().slice(0, 10);
  if (date > to || new Date(candidate + 7 * 86_400_000).toISOString().slice(0, 10) <= to) throw new WeekdayDateRequired();
  if (value.time === undefined) return date;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = value.time.split(":").map(Number) as [number, number];
  const resolved = localIso(zonedToUtc(y, m, d, hh, mm, tz), tz);
  if (!resolved.startsWith(`${date}T${value.time}:`)) throw new Error("That local clock time does not exist");
  return resolved;
}

if (isMain(import.meta.url)) run(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { anchor: { type: "string" } } });
  if (positionals.length !== 1 || positionals[0] !== "next_week" || !values.anchor) throw new Error("usage: time.ts next_week --anchor ISO");
  const { loadConfig } = await import("./config.ts");
  const { timezone } = loadConfig();
  if (typeof timezone !== "string" || !timezone.trim()) throw new Error("owner timezone is missing from config");
  return nextWeek(values.anchor, timezone);
});
