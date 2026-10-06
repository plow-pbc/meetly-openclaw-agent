import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { movableAction } from "../skills/meetly/scripts/movable.ts";
import { calendarAction } from "../skills/meetly/scripts/calendar.ts";
import { answerOwner } from "../skills/meetly/scripts/answer-owner.ts";
import { addRequest, pendingOwnerList, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, fakeCalendar, tmpHome } from "./helpers.ts";

const now = Date.parse("2026-10-03T08:00:00Z"), account = "owner@example.com";
const slot = { start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:30:00Z" };
const owner = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "+15550001111", nativeChannelId: "owner-dm", sessionKey: "agent:main:main" };

for (const scenario of ["allow", "refuse", "same-title", "other-account", "revoked", "email", "prior-grant", "booked", "travel", "asked"] as const) test(`fresh overlap answer binds exact inspected event: ${scenario}`, async t => {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.mock.method(Date, "now", () => now);
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; rmSync(home, { recursive: true, force: true }); });
  const config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: account, calendars: [{ account, id: account }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, { origin: scenario === "asked" ? "owner-group" : "owner", status: scenario === "asked" ? "asked" : "offered", handle: scenario === "email" ? "guest@example.net" : "+15550002222", channel: scenario === "email" ? "email" : "text",
    chatUid: "guest-chat", topic: "Lunch", durationMin: 30, format: scenario === "travel" ? "in_person" : "meet", travel: { beforeMin: scenario === "travel" ? 15 : 0, afterMin: 0 },
    offered: scenario === "asked" ? [] : [{ start: "2026-10-06T12:00:00Z", end: "2026-10-06T12:30:00Z", account }] }, now, "request"));
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]!;
  if (scenario === "booked") writeJson(join(home, "ledger.json"), { requests: [{ ...read(), status: "booked", eventId: "existing-meeting", booked: read().offered[0] }] });
  const event = { ...calendarEvent("inspected", scenario === "travel" ? "2026-10-05T11:45:00Z" : slot.start, scenario === "travel" ? slot.start : slot.end), summary: "Private focus block" };
  const originalBlocker = structuredClone(event);
  const calendar = fakeCalendar([event]);
  const bridge = { token: "fixture", fetch: async (_url: unknown, init?: RequestInit) => {
    const { argv } = JSON.parse(String(init?.body)).params.arguments;
    const result = await calendar.command({ argv });
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: result.output }) }] } });
  } };
  const inspected = await movableAction(owner, { action: "inspect", requestId: "request", candidates: [slot] }, bridge);
  assert.ok(inspected.askedAt, JSON.stringify(inspected));
  const pending = read().pendingOwner!;
  assert.equal(pendingOwnerList({ requests: [read()] }).length, 1);
  assert.ok("question" in pending && pending.overlap);
  assert.deepEqual(pending.overlap.choices[0]!.event, { account, id: "inspected" });
  const sent: string[] = [], send = async (_to: string, text: string) => { sent.push(text); };
  const args = { requestId: "request", askedAt: inspected.askedAt, text: "Private focus block", outcome: scenario === "refuse" ? "refuse_overlap" as const : "allow_overlap" as const };
  const options = { command: calendar.command, now: () => now };
  if (scenario === "prior-grant") writeJson(join(home, "ledger.json"), { requests: [{ ...read(), allowOverlap: [{ account, id: "unapproved" }] }] });
  const before = read();
  assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now }, args, send, options));
  assert.deepEqual(read(), before, "inspection turn cannot answer itself");
  for (const context of [{ ...owner, senderIsOwner: false }, { ...owner, sessionKey: "guest-chat", nativeChannelId: "guest-chat" }]) {
    assert.ok("error" in await answerOwner({ ...context, turnStartedAt: now + 1 }, args, send, options));
    assert.deepEqual(read(), before, "only a private owner answer may consume the decision");
  }
  if (scenario === "same-title" || scenario === "prior-grant") calendar.events.set("unapproved", { ...event, id: "unapproved" });
  if (scenario === "other-account") writeJson(join(home, "config.json"), { ...config, calendars: [...config.calendars, { account: "other@example.com", id: "primary" }] });
  const command = async (cmd: Parameters<typeof calendar.command>[0]) => {
    const result = await calendar.command(cmd);
    if (scenario === "revoked" && cmd.argv[2] === "create") writeJson(join(home, "ledger.json"), { requests: [{ ...read(), pendingOwner: { question: "A newer question", askedAt: new Date(now + 2).toISOString() } }] });
    return result;
  };
  const result: any = await answerOwner({ ...owner, turnStartedAt: now + 1 }, args, send, { ...options, command });
  if (["same-title", "other-account", "revoked", "prior-grant"].includes(scenario)) {
    assert.ok("error" in result, JSON.stringify(result));
    assert.equal(sent.length, 0);
    assert.deepEqual(read().allowOverlap, before.allowOverlap);
    assert.deepEqual(read().offered, before.offered);
    assert.equal([...calendar.events.values()].filter(e => e.id.startsWith("new-") && e.status !== "cancelled").length, 0);
  } else {
    if (scenario === "email") {
      assert.ok(result.email, JSON.stringify(result));
      assert.doesNotMatch(result.email.body, /Private|inspected|example.com/);
      const writes = calendar.calls.filter(c => c[2] === "create").length;
      assert.equal((await answerOwner({ ...owner, turnStartedAt: now + 3 }, { ...args, emailSent: true }, send, options) as any).answered, true);
      assert.equal(calendar.calls.filter(c => c[2] === "create").length, writes);
    } else assert.equal(result.answered, true, JSON.stringify(result));
    assert.equal(read().pendingOwner, undefined);
    assert.equal(read().status, before.status === "asked" ? "offered" : before.status, "overlap permission never books or moves");
    assert.deepEqual(read().booked, before.booked);
    assert.deepEqual(read().allowOverlap ?? [], scenario === "refuse" ? [] : [{ account, id: "inspected" }]);
    assert.equal(sent.length, ["allow", "booked", "travel", "asked"].includes(scenario) ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(sent), /Private|inspected|example.com/);
    assert.equal(readJson<any>(join(home, "overlap-decisions.json"), {})["private focus block"].allowed, scenario !== "refuse");
  }
  if (scenario === "travel") {
    await calendarAction("request", { action: "book", start: slot.start }, options);
    assert.equal(read().travelEvents?.length, 1);
    assert.deepEqual(read().allowOverlap, []);
    await calendarAction("request", { action: "cancel" }, options);
  }
  assert.deepEqual(calendar.events.get("inspected"), originalBlocker, "the approved blocker stays unchanged");
  const writes = calendar.calls.length;
  assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 4 }, args, send, options), "a consumed or superseded answer cannot be replayed");
  assert.equal(calendar.calls.length, writes);
  t.diagnostic(JSON.stringify({ scenario, result, sent, allowed: read().allowOverlap }));
});
