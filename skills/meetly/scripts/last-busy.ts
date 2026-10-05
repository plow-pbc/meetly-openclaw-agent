// The last owner exact-time check (slots.ts --at) that found the time busy.
// It stands in for meetly_movable's candidates, and its clock time is never a
// hard start condition: the asked time was busy, so pinning it would exclude
// every alternative.
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { localIso } from "./time.ts";

export const LAST_BUSY = "tmp/last-busy.json";
export const LAST_BUSY_MS = 30 * 60_000;
export type LastBusy = { slot: { start: string; end: string }; requestId?: string; format?: string; travel?: unknown; checkedAt: string };

export function lastBusy(now = Date.now()): LastBusy | null {
  const last = readJson<LastBusy | null>(file(LAST_BUSY), null);
  return last && now - Date.parse(last.checkedAt) < LAST_BUSY_MS ? last : null;
}

/** Conditions without a start pinned to the clock time that was just found busy. */
export function unpinBusyStart<T extends { startTime?: string; from?: string; to?: string }>(constraints: T | undefined, timezone: string, now = Date.now()): T | undefined {
  const last = constraints?.startTime ? lastBusy(now) : null;
  if (!constraints || !last) return constraints;
  const local = localIso(Date.parse(last.slot.start), timezone);
  const [date, clock] = [local.slice(0, 10), local.slice(11, 16)];
  if (constraints.startTime!.slice(0, 5) !== clock || (constraints.from && date < constraints.from) || (constraints.to && date > constraints.to)) return constraints;
  const { startTime: _pinned, ...rest } = constraints;
  return rest as T;
}
