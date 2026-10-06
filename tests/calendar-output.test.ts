import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarOutput, sendOwnerTravel, withoutPrivateTravel } from "../skills/meetly/scripts/calendar-output.ts";

const note = "Held 10 min travel before and 10 min after lunch — say if that's off.";
const result = { request: { id: "r", travel: { beforeMin: 10, afterMin: 10 }, travelEvents: [{ holdId: "private" }],
  reoffer: { travel: { beforeMin: 45, afterMin: 45 } } }, ownerTravelNote: note };

test("batch and failure results retain only delivery status, never private travel", async () => {
  const sent: string[] = [];
  const output = await calendarOutput({ results: [result, { request: result.request }] }, async text => { sent.push(text); });
  assert.deepEqual(sent, [note]);
  assert.deepEqual(output, { results: [{ request: { id: "r", reoffer: {} }, ownerNotified: true }, { request: { id: "r", reoffer: {} } }] });
  const failed = await calendarOutput(result, async () => { throw new Error(note); });
  assert.equal(failed.ownerNotified, false);
  assert.equal(failed.ownerNotificationWarning, "owner-notification-unconfirmed");
  assert.doesNotMatch(JSON.stringify(failed), /beforeMin|afterMin|travelEvents|ownerTravelNote|Held|say if/);
  assert.deepEqual(withoutPrivateTravel({ ...result, request: null }), { request: null });
  assert.equal(result.request.travel.beforeMin, 10, "presentation must not mutate saved data");
});

const dm = { uid: "private-owner", status: "active", participants: [
  { type: "agent", relationship: "self", line: { uid: "line" } }, { type: "member", role: "owner" },
] };
for (const mode of ["sent", "missing", "ambiguous", "unknown", "error"] as const) test(`private sender resolves owner DM and fails closed: ${mode}`, async () => {
  const posts: string[] = [];
  const send = () => sendOwnerTravel(note, { base: "https://plow.test", token: "fixture", fetch: async (url, init) => {
    if (init?.method !== "POST") {
      assert.equal(String(url), "https://plow.test/v1/agents/me");
      return Response.json({ line: { uid: "line" }, chats: [
        { ...dm, uid: "group", participants: [...dm.participants, { type: "member", role: "member" }] },
        ...(mode === "missing" ? [] : [dm]), ...(mode === "ambiguous" ? [{ ...dm, uid: "second-dm" }] : []),
      ] });
    }
    posts.push(String(url));
    assert.equal(String(url), "https://plow.test/v1/chats/private-owner/messages");
    assert.deepEqual(JSON.parse(String(init.body)), { body: note, attachment_uids: [] });
    if (mode === "error") throw new Error("unknown delivery");
    return Response.json(mode === "unknown" ? {} : { uid: "message-one" });
  } });
  if (mode === "sent") await send(); else await assert.rejects(send);
  assert.equal(posts.length, ["missing", "ambiguous"].includes(mode) ? 0 : 1, "never retry an unknown send or choose a group");
});
