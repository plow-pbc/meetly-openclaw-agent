// Free times to offer: the owner's days and the meeting's window, in the owner's zone,
// clear of busy time, at least MIN_NOTICE_MIN ahead, spread across days.
// The label and weekday come from here so the agent never computes a weekday.
// Lunch and dinner use their own windows; request preferences only narrow them. Outside
// that window or the owner's days, --at requires owner confirmation.
// With a locale (the other person's, e.g. pt-BR or en-US) the label follows
// that locale's date and time conventions; without one it is "tue 29/9 12:00".
import { parseArgs } from "node:util";
import { isMain, readInput, run } from "./cli.ts";
import { loadConfig, MIN_NOTICE_MIN, minutes, parseTime, SLOT_COUNT, STEP_MIN, type Config } from "./config.ts";
import type { Busy } from "./busy.ts";
import { intersectConstraints, type Ledger, type Meal } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { addDays, DAYS, localIso, wallParts, zonedToUtc, type Day } from "./time.ts";

export type Slot = { start: string; end: string; dayOfWeek: Day; label: string };

export type SlotQuery = {
  now: number;
  config: Config;
  busy: Busy[];
  unknownAfter?: string;
  durationMin?: number;
  meal?: Meal;
  days?: Day[];
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  allowOverlap?: string[];
  exclude?: string[];
  count?: number;
  near?: string;
  locale?: string;
};

const MEAL_WINDOWS: Partial<Record<Meal, [string, string]>> = {
  lunch: ["11:30", "13:30"], dinner: ["18:00", "21:00"],
};

function windowFor(config: Config, meal?: Meal): [number, number] {
  const window = meal ? MEAL_WINDOWS[meal] : undefined;
  const [start, end] = window ?? [config.windowStart, config.windowEnd];
  return [minutes(start!), minutes(end!)];
}

export function durationFor(q: { config: Config; meal?: Meal; durationMin?: number }): number {
  return q.durationMin ?? (q.meal === "lunch" || q.meal === "dinner" ? 60 : q.config.durationMin);
}

const pad = (n: number) => String(n).padStart(2, "0");

// Throws on a malformed locale tag, so the CLI fails instead of guessing.
export function localeFormatter(locale: string, tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    throw new Error(`unknown locale: ${locale} (use a tag like pt-BR or en-US)`);
  }
}

function label(ms: number, tz: string, format?: Intl.DateTimeFormat): string {
  if (format) return format.format(new Date(ms));
  const p = wallParts(ms, tz);
  return `${p.weekday} ${p.d}/${p.m} ${pad(p.hh)}:${pad(p.mm)}`;
}

export function findSlots(q: SlotQuery): { slots: Slot[]; unknownAfter?: string } {
  const { config, now } = q;
  const tz = config.timezone;
  const duration = durationFor(q);
  const count = q.count ?? SLOT_COUNT;
  const near = q.near === undefined ? undefined : Date.parse(checkTime({ now, config, busy: [], start: q.near }).slot.start);

  const days = q.days ? config.days.filter((d) => q.days!.includes(d)) : config.days;
  let [startMin, endMin] = windowFor(config, q.meal);
  if (q.after) startMin = Math.max(startMin, minutes(q.after));
  if (q.before) endMin = Math.min(endMin, minutes(q.before));
  startMin = Math.ceil(startMin / STEP_MIN) * STEP_MIN;

  const earliest = now + MIN_NOTICE_MIN * 60_000;
  const excluded = new Set((q.exclude ?? []).map((e) => Date.parse(e)));
  const allowed = new Set(q.allowOverlap ?? []);
  const busy = q.busy
    .filter((b) => b.id === undefined || !allowed.has(b.id))
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  const unknownAfter = q.unknownAfter !== undefined ? Date.parse(q.unknownAfter) : undefined;

  const today = wallParts(now, tz);
  const perDay: { start: number; end: number; day: Day }[][] = [];
  scan: for (let i = 0; i <= config.horizonDays; i++) {
    const { y, m, d } = addDays(today.y, today.m, today.d, i);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if ((q.from && date < q.from) || (q.to && date > q.to)) continue;
    const day = wallParts(zonedToUtc(y, m, d, 12, 0, tz), tz).weekday;
    if (!days.includes(day)) continue;
    const found: { start: number; end: number; day: Day }[] = [];
    for (let t = startMin; t + duration <= endMin; t += STEP_MIN) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const end = start + duration * 60_000;
      if (unknownAfter !== undefined && end > unknownAfter) {
        perDay.push(found);
        break scan;
      }
      if (start < earliest || excluded.has(start)) continue;
      if (busy.some((b) => b.start < end && b.end > start)) continue;
      found.push({ start, end, day });
    }
    perDay.push(found);
  }

  let picked: (typeof perDay)[number];
  if (near !== undefined) {
    // Rank all eligible starts, not just the first start of each day.
    picked = perDay.flat().sort((a, b) => Math.abs(a.start - near) - Math.abs(b.start - near) || a.start - b.start).slice(0, count);
  } else {
    // One per day first, soonest days first; then fill in time order.
    picked = perDay.filter((f) => f.length > 0).map((f) => f[0]!).slice(0, count);
    if (picked.length < count) {
      const rest = perDay.flat().filter((c) => !picked.includes(c));
      picked.push(...rest.slice(0, count - picked.length));
    }
    picked.sort((a, b) => a.start - b.start);
  }

  const format = q.locale !== undefined ? localeFormatter(q.locale, tz) : undefined;
  const slots = picked.map((c) => ({
    start: localIso(c.start, tz),
    end: localIso(c.end, tz),
    dayOfWeek: c.day,
    label: label(c.start, tz, format),
  }));
  return q.unknownAfter !== undefined ? { slots, unknownAfter: q.unknownAfter } : { slots };
}

export type TimeCheck = {
  slot: Slot;
  free: boolean;
  reason?: "busy" | "too-soon" | "unknown";
  outsideHours: boolean;
};

// Checks one exact time the other person asked for. free: clear of busy time
// (except allowOverlap), with enough notice, and inside what was read.
// outsideHours: not on the owner's days or not inside the window, so the
// owner must confirm before it is held or booked.
export function checkTime(q: {
  now: number;
  config: Config;
  busy: Busy[];
  start: string;
  unknownAfter?: string;
  durationMin?: number;
  meal?: Meal;
  allowOverlap?: string[];
  locale?: string;
}): TimeCheck {
  const tz = q.config.timezone;
  // A wall time with no offset (2026-10-03T10:00) is the owner's clock.
  const wall = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(q.start);
  const start = wall
    ? zonedToUtc(Number(wall[1]), Number(wall[2]), Number(wall[3]), Number(wall[4]), Number(wall[5]), tz)
    : Date.parse(q.start);
  if (Number.isNaN(start)) throw new Error(`not a time: ${q.start}`);
  const end = start + durationFor(q) * 60_000;
  const s = wallParts(start, tz);
  const e = wallParts(end, tz);
  const sameDay = s.y === e.y && s.m === e.m && s.d === e.d;
  const [windowStart, windowEnd] = windowFor(q.config, q.meal);
  const outsideHours = !q.config.days.includes(s.weekday) || !sameDay ||
    s.hh * 60 + s.mm < windowStart || e.hh * 60 + e.mm > windowEnd;
  const allowed = new Set(q.allowOverlap ?? []);
  let reason: TimeCheck["reason"];
  if (q.unknownAfter !== undefined && end > Date.parse(q.unknownAfter)) reason = "unknown";
  else if (start < q.now + MIN_NOTICE_MIN * 60_000) reason = "too-soon";
  else if (q.busy.some((b) => (b.id === undefined || !allowed.has(b.id)) && Date.parse(b.start) < end && Date.parse(b.end) > start)) {
    reason = "busy";
  }
  const format = q.locale !== undefined ? localeFormatter(q.locale, tz) : undefined;
  const slot: Slot = { start: localIso(start, tz), end: localIso(end, tz), dayOfWeek: s.weekday, label: label(start, tz, format) };
  return reason ? { slot, free: false, reason, outsideHours } : { slot, free: true, outsideHours };
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${flag} must be a positive whole number, got ${raw}`);
  return Number(raw);
}

function date(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${flag} must be YYYY-MM-DD, got ${raw}`);
  return raw;
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: {
        in: { type: "string" },
        request: { type: "string" },
        duration: { type: "string" },
        meal: { type: "string" },
        days: { type: "string" },
        after: { type: "string" },
        before: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "allow-overlap": { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        count: { type: "string" },
        at: { type: "string" },
        near: { type: "string" },
        now: { type: "string" },
        locale: { type: "string" },
      },
    });
    const config = loadConfig();
    if (values.meal !== undefined && !["lunch", "dinner", "coffee"].includes(values.meal)) throw new Error("--meal must be lunch, dinner or coffee");
    const meal = values.meal as Meal | undefined;
    const input = JSON.parse(readInput(values.in !== undefined ? [values.in] : [])[0]!) as {
      busy?: Busy[];
      allowOverlap?: string[];
      unknownAfter?: string;
      degraded?: string[];
    };
    if (!Array.isArray(input.busy)) throw new Error("the busy input has no busy list (pass busy.ts output)");
    const now = values.now !== undefined ? Date.parse(values.now) : Date.now();
    if (Number.isNaN(now)) throw new Error(`--now is not a time: ${values.now}`);
    const degraded = input.degraded ?? [];
    if (values.at !== undefined) {
      for (const flag of ["days", "after", "before", "from", "to", "exclude", "count", "near", "request"] as const) {
        if (values[flag] !== undefined) throw new Error(`--at checks one time; drop --${flag}`);
      }
      const check: Parameters<typeof checkTime>[0] = { now, config, meal, busy: input.busy, start: values.at, allowOverlap: input.allowOverlap };
      if (input.unknownAfter !== undefined) check.unknownAfter = input.unknownAfter;
      if (values.duration !== undefined) check.durationMin = positiveInt(values.duration, "--duration");
      if (values["allow-overlap"]) check.allowOverlap = values["allow-overlap"];
      if (values.locale !== undefined) check.locale = values.locale;
      return { ...checkTime(check), degraded };
    }
    const q: SlotQuery = { now, config, meal, busy: input.busy, allowOverlap: input.allowOverlap };
    if (input.unknownAfter !== undefined) q.unknownAfter = input.unknownAfter;
    if (values.duration !== undefined) q.durationMin = positiveInt(values.duration, "--duration");
    if (values.count !== undefined) q.count = positiveInt(values.count, "--count");
    if (values.near !== undefined) q.near = values.near;
    if (values.days !== undefined) {
      q.days = values.days.split(/[\s,]+/).filter(Boolean).map((d) => {
        const day = d.slice(0, 3).toLowerCase();
        if (!(DAYS as readonly string[]).includes(day)) throw new Error(`not a day of the week: ${d}`);
        return day as Day;
      });
    }
    if (values.after !== undefined) q.after = parseTime(values.after);
    if (values.before !== undefined) q.before = parseTime(values.before);
    if (values.from !== undefined) q.from = date(values.from, "--from");
    if (values.to !== undefined) q.to = date(values.to, "--to");
    if (values["allow-overlap"]) q.allowOverlap = values["allow-overlap"];
    if (values.locale !== undefined) q.locale = values.locale;
    if (values.exclude) {
      for (const e of values.exclude) if (Number.isNaN(Date.parse(e))) throw new Error(`--exclude is not a time: ${e}`);
      q.exclude = values.exclude;
    }
    if (values.request !== undefined) {
      const request = readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === values.request);
      if (!request || request.status !== "offered") throw new Error("--request needs an offered request");
      const narrowed = intersectConstraints(request.constraints, q);
      Object.assign(q, narrowed);
      q.meal = request.meal;
      q.durationMin ??= request.durationMin;
      q.locale ??= request.locale;
      q.allowOverlap = request.allowOverlap;
      q.busy = q.busy.filter(b => !request.offered.some(o => o.holdId && o.holdId === b.id && o.account === b.account));
    }
    return { ...findSlots(q), degraded };
  });
}
