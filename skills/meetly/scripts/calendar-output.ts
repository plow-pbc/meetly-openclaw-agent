import { ownerChat, plowApi, type ApiOptions } from "./owner-chat.ts";

// CLI results can reach a group even when the command was requested by its owner.
export function withoutPrivateTravel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrivateTravel);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["travel", "travelEvents", "ownerTravelNote", "beforeMin", "afterMin"].includes(key))
    .map(([key, child]) => [key, withoutPrivateTravel(child)]));
}

export async function sendOwnerTravel(text: string, options: ApiOptions = {}): Promise<void> {
  const { chatUid } = await ownerChat(options);
  const api = plowApi(options);
  const response = await api.fetch(`${api.base}/v1/chats/${encodeURIComponent(chatUid)}/messages`, {
    method: "POST", headers: { ...api.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body: text, attachment_uids: [] }), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const uid = response.ok ? (await response.json() as { uid?: unknown }).uid : undefined;
  if (typeof uid !== "string" || !uid.trim()) {
    throw new Error("Owner notification is unconfirmed.");
  }
}

type Result = { ownerTravelNote?: string; travelOnly?: boolean; results?: Result[]; [key: string]: unknown };
export async function calendarOutput(result: Result, sendOwner = sendOwnerTravel): Promise<Record<string, unknown>> {
  const { travelOnly, ...publicResult } = result;
  const output = withoutPrivateTravel(publicResult) as Record<string, unknown>;
  if (result.results) output.results = await Promise.all(result.results.map(item => calendarOutput(item, sendOwner)));
  if (result.ownerTravelNote) {
    try {
      await sendOwner(result.ownerTravelNote);
      output.ownerNotified = true;
      if (travelOnly) output.ownerReply = { action: "silent", message: "Finish with exactly NO_REPLY. The travel update was already delivered privately; do not repeat or summarize it." };
      else output.ownerReply = { action: "already_notified", message: "The owner already received the calendar update privately. Deliver any required guest confirmation once. From the owner's DM, then finish NO_REPLY without another completion message. In the meeting group, still confirm the meeting result. Report a guest-delivery failure privately if needed; never repeat private travel details." };
    } catch {
      output.ownerNotified = false;
      output.ownerNotificationWarning = "owner-notification-unconfirmed";
    }
  }
  return output;
}
