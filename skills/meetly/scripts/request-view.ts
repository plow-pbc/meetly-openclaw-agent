import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { currentOffers, type Ledger, type Request } from "./ledger.ts";
import { file } from "./paths.ts";
import { localeFormatter } from "./slots.ts";
import { readJson, updateJson } from "./store.ts";

const needsDetails = (request: Request) => ["offered", "booked"].includes(request.status)
  && request.origin !== "owner-group" && !request.detailsAskedAt
  && (!request.format || request.format === "unknown" || (request.format === "in_person" && !request.location?.trim()));

export function view(request: Request, config: Config) {
  let askDetails = false;
  if (needsDetails(request)) updateJson<Ledger>(file("ledger.json"), { requests: [] }, ledger => {
    const current = ledger.requests.find(r => r.id === request.id);
    if (!current || current.chatUid !== request.chatUid || current.handle !== request.handle) throw new Error("request changed");
    request = current;
    if (!needsDetails(current)) return ledger;
    // Reserve before returning permission to ask; a lost reply must not ask twice.
    askDetails = true;
    const at = new Date(Date.now()).toISOString();
    return { requests: ledger.requests.map(r => r.id === current.id ? { ...r, detailsAskedAt: at, updatedAt: at } : r) };
  });
  const format = localeFormatter(request.locale ?? "en-US", config.timezone);
  const time = (slot: { start: string; end: string }) => ({ start: slot.start, end: slot.end, label: format.format(new Date(slot.start)) });
  const offered = currentOffers(request).map(time);
  return {
    askDetails, status: request.status, origin: request.origin, ownerName: config.ownerName, timezone: config.timezone,
    topic: request.topic, meal: request.meal, durationMin: request.durationMin, format: request.format ?? "unknown", location: request.location,
    offered,
    ...(request.status === "booked" && offered.length ? { message: `Replacement times are held: ${offered.map(o => o.label).join("; ")} (${config.timezone}). The current booking remains unchanged until you pick a replacement.` } : {}),
    ...(request.booked ? { booked: time(request.booked), reminderAvailable: !!request.meetUrl } : {}),
    ...(request.pendingOwner ? { pendingOwner: "question" in request.pendingOwner ? { question: request.pendingOwner.question } : time(request.pendingOwner) } : {}),
    ...(request.holdCleanup?.length ? { cleanupPending: true } : {}),
  };
}

if (isMain(import.meta.url)) run(() => {
  const { values } = parseArgs({ options: { id: { type: "string" } } });
  const request = readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.find(r => r.id === values.id);
  if (!request) throw new Error("request-view.ts needs --id for an existing request");
  return view(request, loadConfig());
});
