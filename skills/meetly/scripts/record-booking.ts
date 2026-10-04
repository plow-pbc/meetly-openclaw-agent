// Records a booked event in the ledger from plow-gog's own output, so the
// event id, its time and its Meet link are copied, never retyped. The calendar
// writer calls this when committing a booking or format change.
import type { EventInfo } from "./event.ts";
import { updateRequest, type Ledger, type Patch, type Request } from "./ledger.ts";

export type Recorded = { ledger: Ledger; meetUrl: string | null; warning?: "no-meet-link" };

export function recordBooking(ledger: Ledger, id: string, event: EventInfo, account: string, now: number): Recorded {
  const request = ledger.requests.find((r) => r.id === id);
  if (!request) throw new Error(`no request ${id}`);
  if (request.status !== "offered" && request.status !== "booked") throw new Error(`request ${id} is ${request.status}, not open`);
  if (request.status === "booked" && request.eventId !== undefined && request.eventId !== event.id) {
    throw new Error(`request ${id} is already booked as ${request.eventId}, not ${event.id}`);
  }
  if (event.status === "cancelled") throw new Error(`event ${event.id} is cancelled`);
  if (!account) throw new Error("--account is required: the Google account the event is on");
  const isMeet = request.format === "meet";
  const patch: Patch = {
    status: "booked",
    eventId: event.id,
    booked: { start: event.start, end: event.end, account },
    meetUrl: isMeet ? event.meetUrl : null,
  };
  // A reminder belongs to one start time: a moved meeting gets a new one.
  if (request.booked && Date.parse(request.booked.start) !== Date.parse(event.start)) patch.reminder = null;
  // Keep an owner approval linked until its answer is delivered to the group.
  const next = updateRequest(ledger, id, patch, now);
  const meetUrl = (next.requests.find((r) => r.id === id) as Request).meetUrl ?? null;
  return { ledger: next, meetUrl, ...(isMeet && !meetUrl ? { warning: "no-meet-link" as const } : {}) };
}
