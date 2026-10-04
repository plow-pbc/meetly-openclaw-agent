import type { Format, Meal } from "./ledger.ts";

export type Travel = { beforeMin: number; afterMin: number; override?: boolean };
export type TravelInput = { format?: Format; meal?: Meal; travel?: Travel };

export function checkTravel(travel: Travel): void {
  if (!travel || ![travel.beforeMin, travel.afterMin].every(n => Number.isInteger(n) && n >= 0 && n <= 120)
    || (travel.override !== undefined && typeof travel.override !== "boolean")) {
    throw new Error("travel needs beforeMin and afterMin as whole minutes from 0 to 120");
  }
}

export function travelFor(input: TravelInput): Travel {
  if (input.travel === undefined) throw new Error("Supply an explicit travel estimate, including zero minutes for virtual meetings");
  checkTravel(input.travel);
  if ((input.format === "meet" || input.format === "phone") && (input.travel.beforeMin || input.travel.afterMin))
    throw new Error("Virtual meetings require zero travel minutes");
  return input.travel;
}

export function travelRange(start: string | number, end: string | number, input: TravelInput) {
  const travel = travelFor(input);
  return { from: new Date((typeof start === "number" ? start : Date.parse(start)) - travel.beforeMin * 60_000).toISOString(),
    to: new Date((typeof end === "number" ? end : Date.parse(end)) + travel.afterMin * 60_000).toISOString() };
}

export function travelNote(request: TravelInput & { topic: string; location?: string }): string | undefined {
  const { beforeMin, afterMin } = travelFor(request);
  return beforeMin || afterMin
    ? `Held ${beforeMin} min travel before and ${afterMin} min after ${request.topic}${request.location ? ` at ${request.location}` : ""} — say if that's off.` : undefined;
}

export class TravelBaseRequired extends Error {
  constructor() { super("Ask the owner privately for their home/office base before preparing in-person travel"); }
}

export function checkTravelBase(input: TravelInput, base?: string): void {
  const travel = travelFor(input);
  if (!base?.trim() && (input.format === "in_person" || travel.beforeMin || travel.afterMin)) throw new TravelBaseRequired();
}
