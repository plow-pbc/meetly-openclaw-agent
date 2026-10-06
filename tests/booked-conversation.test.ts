import assert from "node:assert/strict";
import { test } from "node:test";
import { addRequest } from "../skills/meetly/scripts/ledger.ts";

const at = Date.parse("2026-10-05T08:00:00Z");
const base = addRequest({ requests: [] }, {
  origin: "owner", handle: "+15555550101", name: "Guest", topic: "Call", durationMin: 30,
  travel: { beforeMin: 0, afterMin: 0 }, status: "asked", offered: [],
  constraints: { from: "2026-10-05", to: "2026-10-06", days: ["mon"], after: "10:00" }, excludedDays: ["tue"],
}, at, "one").requests[0]!;

test("new ledger records cannot create a second meeting in a booked conversation", () => {
  const booked = { ...base, status: "booked" as const, chatUid: "chat" };
  const { id, status, createdAt, updatedAt, ...input } = base;
  assert.throws(() => addRequest({ requests: [booked] }, {
    ...input, status: "asked", origin: "owner-group", chatUid: "chat",
  }, at, "second"), /SEPARATE_MEETING_REQUIRED/);
});
