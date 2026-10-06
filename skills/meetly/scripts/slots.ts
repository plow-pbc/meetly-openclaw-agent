// Free times to offer: the owner's days and the meeting's window, in the owner's zone,
// clear of busy time, at least MIN_NOTICE_MIN ahead, spread across days.
// The label and weekday come from here so the agent never computes a weekday.
// Lunch and dinner use their own windows unless the owner selected an exact start.
// Guest preferences only narrow them; other times require owner confirmation.
// With a locale (the other person's, e.g. pt-BR or en-US) the label follows
// that locale's date and time conventions; without one it is "tue 29/9 12:00".
import { travelRange, type TravelInput } from "./travel.ts";
import { parseArgs } from "node:util";
import { isMain, readInput, run } from "./cli.ts";
import { loadConfig, MEAL_DEFAULTS, MIN_NOTICE_MIN, minutes, parseTime, SLOT_COUNT, STEP_MIN, type Config } from "./config.ts";
import { allowsOverlap, covers, fetchBusy, uniqueEvents, type Coverage, type EventRef, type Busy } from "./busy.ts";
import { requestEvents, intersectConstraints, meetingDuration, requireDuration, sameRequest, updateRequest, type Ledger, type Meal } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";
import { addDays, DAYS, localIso, nextWeek, parseStart, wallParts, zonedToUtc, type Day } from "./time.ts";

export type Slot = { start: string; end: string; dayOfWeek: Day; label: string };

export type Constraints = { startTime?: string; days?: string[]; after?: string; before?: string; from?: string; to?: string };
export type SearchTiming = { week?: "this" | "next"; asap?: boolean };

export type SlotQuery = Constraints & TravelInput & {
  now: number;
  config: Config;
  busy: Busy[];
  unknownAfter?: string;
  coverage?: Coverage;
  durationMin?: number;
  meal?: Meal;
  allowOverlap?: EventRef[];
  exclude?: string[];
  asap?: boolean;
  count?: number;
  near?: string;
  locale?: string;
};

function windowFor(config: Config, meal?: Meal, startTime?: string, durationMin?: number): [number, number] {
  // An explicit owner-selected clock time replaces the default meeting window.
  if (startTime !== undefined) {
    const start = minutes(parseTime(startTime));
    return [start, start + requireDuration(durationMin)];
  }
  const window = meal ? MEAL_DEFAULTS[meal]?.window : undefined;
  const [start, end] = window ?? [config.windowStart, config.windowEnd];
  return [minutes(start!), minutes(end!)];
}


const pad = (n: number) => String(n).padStart(2, "0");

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function resolveSearchConstraints(input: Constraints, week: SearchTiming["week"], now: number, timezone: string): Constraints {
  const constraints = Object.fromEntries(Object.entries(intersectConstraints({}, input)).filter(([, value]) => value !== undefined));
  if (week === undefined) return constraints;
  if (week !== "this" && week !== "next") throw new Error("week must be this or next");
  if (input.from || input.to) throw new Error("week resolves dates itself; omit from and to");
  const next = nextWeek(new Date(now).toISOString(), timezone);
  return { ...constraints, ...(week === "next" ? next : { from: shiftDate(next.from, -7), to: shiftDate(next.to, -7) }) };
}

// The horizon supplies missing bounds; explicit dates are never clipped to it.
export function searchBounds(q: Pick<SlotQuery, "config" | "now" | "from" | "to">) {
  const today = localIso(q.now, q.config.timezone).slice(0, 10);
  const from = q.from && q.from > today ? q.from : today;
  return { from, to: q.to ?? shiftDate(from, q.config.horizonDays) };
}

export function searchCoverage(q: SlotQuery): Coverage {
  const bounds = searchBounds(q);
  const midnight = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return zonedToUtc(y!, m!, d!, 0, 0, q.config.timezone);
  };
  return travelRange(midnight(bounds.from), midnight(shiftDate(bounds.to, 1)), q);
}

export function preferredSearchCoverage(query: SlotQuery, preferred?: Constraints): Coverage {
  const fallback = searchCoverage(query);
  const requested = searchCoverage({ ...query, ...intersectConstraints(query, preferred) });
  return { from: [fallback.from, requested.from].sort()[0]!, to: [fallback.to, requested.to].sort().at(-1)! };
}

type SlotResult = {
  slots: Slot[];
  durationMin: number;
  resolvedConstraints: Constraints;
  unknownAfter?: string;
  incomplete?: { reason: "calendar-coverage" | "truncated-calendar"; requiredCoverage: Coverage };
};

// Throws on a malformed locale tag, so the CLI fails instead of guessing.
export function localeFormatter(locale: string, tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, timeZoneName: "short", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    throw new Error(`unknown locale: ${locale} (use a tag like pt-BR or en-US)`);
  }
}

function label(ms: number, tz: string, format?: Intl.DateTimeFormat): string {
  if (format) return format.format(new Date(ms));
  const p = wallParts(ms, tz);
  return `${p.weekday} ${p.d}/${p.m} ${pad(p.hh)}:${pad(p.mm)} ${tz}`;
}

export function withinConstraints(start: number, end: number, timezone: string, constraints: Constraints = {}): boolean {
  const s = localIso(start, timezone), e = localIso(end, timezone);
  const date = s.slice(0, 10);
  return !(constraints.days && !constraints.days.includes(wallParts(start, timezone).weekday))
    && !(constraints.from && date < constraints.from) && !(constraints.to && date > constraints.to)
    && !(constraints.startTime && s.slice(11, 16) !== parseTime(constraints.startTime))
    && !(constraints.after && s.slice(11, 16) < constraints.after)
    && !(constraints.before && (e.slice(0, 10) !== date || e.slice(11, 16) > constraints.before));
}

export function findPreferredSlots(query: SlotQuery, preferred: Constraints = {}, fallbacks: SlotQuery[] = [query]) {
  let result = findSlots({ ...query, ...intersectConstraints(query, preferred) });
  const preferencesUnavailable = result.slots.length === 0 && !result.incomplete;
  for (const fallback of fallbacks) {
    if (result.slots.length || result.incomplete) break;
    result = findSlots(fallback);
  }
  return { ...result, preferencesUnavailable };
}

function unpinBusyStart(constraints: Constraints, start: string, timezone: string): Constraints {
  const local = localIso(Date.parse(start), timezone), date = local.slice(0, 10);
  if (constraints.startTime !== local.slice(11, 16) || (constraints.from && date < constraints.from) || (constraints.to && date > constraints.to)) return constraints;
  const { startTime: _busy, ...rest } = constraints;
  return rest;
}

async function nearbyAlternatives(q: SlotQuery, start: string, own: EventRef[]) {
  const date = localIso(Date.parse(start), q.config.timezone).slice(0, 10), from = shiftDate(date, -2), to = shiftDate(date, 2);
  const conditions = unpinBusyStart(resolveSearchConstraints(q, undefined, q.now, q.config.timezone), start, q.config.timezone);
  const query: SlotQuery = { ...conditions, now: q.now, config: q.config, durationMin: q.durationMin, meal: q.meal,
    format: q.format, travel: q.travel, locale: q.locale, count: q.count, allowOverlap: q.allowOverlap,
    from: conditions.from && conditions.from > from ? conditions.from : from,
    to: conditions.to && conditions.to < to ? conditions.to : to,
    near: start, exclude: [...(q.exclude ?? []), start], busy: q.busy, coverage: q.coverage, unknownAfter: q.unknownAfter };
  if (query.from! > query.to!) return { ...findSlots(query), degraded: [] };
  const needed = searchCoverage(query);
  const data = !covers(q.coverage, needed) || (q.unknownAfter !== undefined && Date.parse(q.unknownAfter) < Date.parse(needed.to))
    ? await fetchBusy(q.config, needed) : { busy: q.busy, coverage: q.coverage, unknownAfter: q.unknownAfter, degraded: [] };
  const result = findSlots({ ...query, ...data, unknownAfter: data.unknownAfter, busy: data.busy.filter(b => !own.some(ref => ref.account === b.account && ref.id === b.id)) });
  return { ...result, slots: data.degraded.length || result.incomplete ? [] : result.slots, degraded: data.degraded };
}

export function findSlots(q: SlotQuery): SlotResult {
  const { config, now } = q;
  const tz = config.timezone;
  const resolvedConstraints = Object.fromEntries(Object.entries(intersectConstraints({}, q)).filter(([, value]) => value !== undefined));
  if (q.asap && q.near) throw new Error("asap searches earliest first; omit near");
  const duration = meetingDuration(q.durationMin, q.meal, q.config.durationMin);
  const count = Math.min(q.count ?? SLOT_COUNT, SLOT_COUNT);
  const near = q.near === undefined ? undefined : Date.parse(checkTime({ now, config, durationMin: duration, busy: [], travel: { beforeMin: 0, afterMin: 0 }, start: q.near }).slot.start);

  let [startMin, endMin] = windowFor(config, q.meal, q.startTime, duration);
  const exactStart = q.startTime === undefined ? undefined : minutes(parseTime(q.startTime));
  if (exactStart !== undefined && exactStart < startMin) return { slots: [], durationMin: duration, resolvedConstraints };
  startMin = exactStart ?? Math.ceil(startMin / STEP_MIN) * STEP_MIN;

  const earliest = now + MIN_NOTICE_MIN * 60_000;
  const excluded = new Set((q.exclude ?? []).map((e) => Date.parse(e)));
  const busy = q.busy
    .filter((b) => !allowsOverlap(b, q.allowOverlap))
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  const unknownAfter = q.unknownAfter !== undefined ? Date.parse(q.unknownAfter) : undefined;

  const bounds = searchBounds(q);
  const [y0, m0, d0] = bounds.from.split("-").map(Number);
  const days = (Date.parse(bounds.to) - Date.parse(bounds.from)) / 86_400_000;
  let incomplete: SlotResult["incomplete"];
  const perDay: { start: number; end: number; day: Day }[][] = [];
  scan: for (let i = 0; i <= days; i++) {
    const { y, m, d } = addDays(y0!, m0!, d0!, i);
    const day = wallParts(zonedToUtc(y, m, d, 12, 0, tz), tz).weekday;
    if (!config.days.includes(day)) continue;
    const found: { start: number; end: number; day: Day }[] = [];
    for (let t = startMin; t + duration <= endMin && (exactStart === undefined || t === exactStart); t += STEP_MIN) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const end = start + duration * 60_000;
      if (start < earliest || excluded.has(start) || !withinConstraints(start, end, tz, q)) continue;
      const range = travelRange(start, end, q);
      if (unknownAfter !== undefined && Date.parse(range.to) > unknownAfter) {
        incomplete = { reason: "truncated-calendar", requiredCoverage: searchCoverage(q) };
        perDay.push(found);
        break scan;
      }
      if (!covers(q.coverage, range)) {
        incomplete = { reason: "calendar-coverage", requiredCoverage: searchCoverage(q) };
        continue;
      }
      if (busy.some((b) => b.start < Date.parse(range.to) && b.end > Date.parse(range.from))) continue;
      found.push({ start, end, day });
    }
    perDay.push(found);
  }

  let picked: (typeof perDay)[number];
  if (q.asap) {
    picked = perDay.flat().slice(0, count);
  } else if (near !== undefined) {
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
  return { slots, durationMin: duration, resolvedConstraints, ...(incomplete ? { incomplete } : {}),
    ...(q.unknownAfter !== undefined ? { unknownAfter: q.unknownAfter } : {}) };
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
export function checkTime(q: TravelInput & {
  now: number;
  config: Config;
  busy: Busy[];
  start: string;
  unknownAfter?: string;
  coverage?: Coverage;
  durationMin?: number;
  meal?: Meal;
  startTime?: string;
  allowOverlap?: EventRef[];
  locale?: string;
}): TimeCheck {
  const tz = q.config.timezone;
  const start = parseStart(q.start, tz);
  const end = start + meetingDuration(q.durationMin, q.meal, q.config.durationMin) * 60_000;
  const s = wallParts(start, tz);
  const e = wallParts(end, tz);
  const sameDay = s.y === e.y && s.m === e.m && s.d === e.d;
  const [windowStart, windowEnd] = windowFor(q.config, q.meal, q.startTime, meetingDuration(q.durationMin, q.meal, q.config.durationMin));
  const outsideHours = !q.config.days.includes(s.weekday) || (q.startTime === undefined && !sameDay) ||
    s.hh * 60 + s.mm < windowStart || e.hh * 60 + e.mm > windowEnd;
  const range = travelRange(start, end, q);
  let reason: TimeCheck["reason"];
  if (!covers(q.coverage, range) || (q.unknownAfter !== undefined && Date.parse(range.to) > Date.parse(q.unknownAfter))) reason = "unknown";
  else if (start < q.now + MIN_NOTICE_MIN * 60_000) reason = "too-soon";
  else if (q.busy.some((b) => (!allowsOverlap(b, q.allowOverlap)) && Date.parse(b.start) < Date.parse(range.to) && Date.parse(b.end) > Date.parse(range.from))) {
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
  run(async () => {
    const { values } = parseArgs({
      options: {
        in: { type: "string" },
        request: { type: "string" },
        duration: { type: "string" },
        meal: { type: "string" },
        format: { type: "string" },
        travel: { type: "string" },
        days: { type: "string" },
        after: { type: "string" },
        "start-time": { type: "string" },
        before: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        week: { type: "string" },
        asap: { type: "boolean" },
        "allow-overlap": { type: "string", multiple: true },
        "no-overlap": { type: "boolean", default: false },
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
      allowOverlap?: EventRef[];
      unknownAfter?: string;
      coverage?: Coverage;
      degraded?: string[];
    };
    if (!Array.isArray(input.busy)) throw new Error("the busy input has no busy list (pass busy.ts output)");
    const now = values.now !== undefined ? Date.parse(values.now) : Date.now();
    if (Number.isNaN(now)) throw new Error(`--now is not a time: ${values.now}`);
    const degraded = input.degraded ?? [];
    const request = values.request === undefined ? undefined
      : readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === values.request);
    if (values.request !== undefined && (!request || !["asked", "offered", "booked"].includes(request.status))) throw new Error("--request needs an asked, offered or booked request");
    if (request) input.busy = input.busy.filter(b => !requestEvents(request).some(o => o.holdId === b.id && o.account === b.account));
    const q: SlotQuery = { format: values.format as SlotQuery["format"], travel: values.travel ? JSON.parse(values.travel) : undefined, now, config, meal, busy: input.busy, allowOverlap: input.allowOverlap };
    q.coverage = input.coverage;
    if (values["start-time"] !== undefined) q.startTime = parseTime(values["start-time"]);
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
    Object.assign(q, resolveSearchConstraints(q, values.week as SearchTiming["week"], now, config.timezone));
    q.asap = values.asap;
    if (values["allow-overlap"]) q.allowOverlap = values["allow-overlap"].map(value => JSON.parse(value));
    if (values.locale !== undefined) q.locale = values.locale;
    if (values.exclude) {
      for (const e of values.exclude) if (Number.isNaN(Date.parse(e))) throw new Error(`--exclude is not a time: ${e}`);
      q.exclude = values.exclude;
    }
    if (request) {
      const { from: _from, to: _to, ...savedPolicy } = request.constraints ?? {};
      const narrowed = intersectConstraints(values.week === undefined ? request.constraints : savedPolicy, q);
      Object.assign(q, narrowed);
      q.days = (q.days ?? DAYS).filter(day => !request.excludedDays?.includes(day));
      q.meal ??= request.meal;
      q.format ??= request.format;
      q.travel = request.travel?.override && q.format !== "meet" && q.format !== "phone" ? request.travel : q.travel ?? request.travel;
      q.durationMin ??= request.durationMin;
      q.locale ??= request.locale;
      q.allowOverlap = uniqueEvents([...(request.allowOverlap ?? []), ...(q.allowOverlap ?? [])]);
      if (request.booked) q.exclude = [...(q.exclude ?? []), request.booked.start];
    }
    if (values["no-overlap"]) q.allowOverlap = [];
    if (values.at !== undefined) {
      for (const flag of ["days", "after", "before", "from", "to", "exclude", "count", "near", "start-time", "week", "asap"] as const) {
        if (values[flag] !== undefined) throw new Error(`--at checks one time; drop --${flag}`);
      }
      const start = checkTime({ ...q, travel: { beforeMin: 0, afterMin: 0 }, start: values.at }).slot.start;
      if (request?.status === "booked" && request.bookedReplacement && request.replacement
        && request.offered.some(slot => Date.parse(slot.start) === Date.parse(start))) Object.assign(q, request.replacement);
      const result = checkTime({ ...q, start });
      const busy = result.reason === "busy" && !degraded.length;
      const resolvedConstraints = busy ? unpinBusyStart(resolveSearchConstraints(q, undefined, now, config.timezone), result.slot.start, config.timezone) : undefined;
      const conditions = busy && request?.constraints ? unpinBusyStart(request.constraints, result.slot.start, config.timezone) : request?.constraints;
      if (request && conditions !== request.constraints) updateJson<Ledger>(file("ledger.json"), { requests: [] }, latest => {
        if (!sameRequest(latest.requests.find(r => r.id === request.id), request)) throw new Error("request changed; check its time again");
        return updateRequest(latest, request.id, { constraints: conditions }, now);
      });
      const nearby = busy ? await nearbyAlternatives(q, result.slot.start,
        request ? requestEvents(request).map(o => ({ account: o.account, id: o.holdId })) : []) : undefined;
      const next = busy ? { reply: "Tell the owner the requested time is busy and present the returned alternatives in their ranked order in this same reply. Save resolvedConstraints on this request; do not pin the busy start or ask permission to search. If degraded or alternativesIncomplete is present, report incomplete calendar coverage instead of claiming no times exist." }
        : result.reason === "unknown" ? { read: "Fetch busy.ts --fetch --from ISO --to ISO covering the meeting and all travel, then check again. Unread time is not free. Never use a calendar write to test availability." } : undefined;
      return { ...result, ...(busy ? { resolvedConstraints } : {}), degraded: [...degraded, ...(nearby?.degraded ?? [])],
        ...(nearby ? { alternatives: nearby.slots, ...(nearby.incomplete ? { alternativesIncomplete: nearby.incomplete } : {}) } : {}), ...(next ? { next } : {}) };
    }
    return { ...findSlots(q), degraded };
  });
}
