// A `message` send with no destination or no text cannot succeed, and the
// model reads OpenClaw's generic refusal as a reason to try the same call
// again. Name exactly what is missing instead.
export function sendPolicy(event) {
  if (event.toolName !== "message" || event.params?.action !== "send") return undefined;
  const params = event.params;
  const missing = [
    !params.target && !(Array.isArray(params.targets) && params.targets.length) ? "target (the chat uid, e.g. the chatUid owner-chat.ts printed)" : "",
    typeof params.message !== "string" || !params.message.trim() ? "message (the text to send)" : "",
  ].filter(Boolean);
  if (!missing.length) return undefined;
  return { block: true, blockReason: `This send has no ${missing.join(" and no ")}. Call message again with channel "plow", accountId "chat", target and message all set, or send nothing and end the turn.` };
}
