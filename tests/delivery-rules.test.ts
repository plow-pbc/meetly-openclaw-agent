import assert from "node:assert/strict";
import { test } from "node:test";
import { addRequest } from "../skills/meetly/scripts/ledger.ts";
import { pendingNudges } from "../skills/meetly/scripts/pipeline.ts";

const at = Date.parse("2026-10-05T08:00:00Z");
const base = addRequest({ requests: [] }, {
  origin: "owner", handle: "+15555550101", name: "Guest", topic: "Call", durationMin: 30,
  travel: { beforeMin: 0, afterMin: 0 }, status: "asked", offered: [],
  constraints: { from: "2026-10-05", to: "2026-10-06", days: ["mon"], after: "10:00" }, excludedDays: ["tue"],
}, at, "one").requests[0]!;

test("owner-originated asked requests never receive bare offer-time nudges", () => {
  const inbound = { ...base, id: "inbound", origin: "inbound" as const };
  assert.deepEqual(pendingNudges({ requests: [base, { ...base, id: "group", origin: "owner-group" }, inbound] }, at).map(r => r.id), ["inbound"]);
});
