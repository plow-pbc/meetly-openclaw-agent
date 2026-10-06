import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { movableAction } from "../skills/meetly/scripts/movable.ts";
import { guestAction } from "../skills/meetly/scripts/guest.ts";
import { calendarAction, offerRequest } from "../skills/meetly/scripts/calendar.ts";
import { answerOwner } from "../skills/meetly/scripts/answer-owner.ts";
import { addRequest, pendingOwnerList, recordDelivery, updateRequest, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { calendarEvent, fakeCalendar, tmpHome } from "./helpers.ts";

const now = Date.parse("2026-10-03T08:00:00Z"), account = "owner@example.com";
const slot = { start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:30:00Z" };
const owner = { messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true, requesterSenderId: "+15550001111", nativeChannelId: "owner-dm", sessionKey: "agent:main:main" };

for (const scenario of ["allow", "refuse", "same-title", "other-account", "revoked", "email", "prior-grant", "booked", "travel", "asked", "travel-estimate", "guest-search", "guest-exact", "replacement", "clear-grant", "wrong-interval", "delivery-failure", "second-choice", "email-choice", "format-growth", "travel-growth", "new-request"] as const) test(`fresh overlap answer binds exact inspected event: ${scenario}`, async t => {
  const home = tmpHome(), old = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = home;
  t.mock.method(Date, "now", () => now);
  t.after(() => { if (old === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = old; rmSync(home, { recursive: true, force: true }); });
  const config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: account, calendars: [{ account, id: account }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  writeJson(join(home, "ledger.json"), addRequest({ requests: [] }, { origin: scenario === "asked" ? "owner-group" : "owner", status: scenario === "asked" ? "asked" : "offered", handle: scenario.startsWith("email") ? "guest@example.net" : "+15550002222", channel: scenario.startsWith("email") ? "email" : "text",
    chatUid: "guest-chat", topic: "Lunch", durationMin: 30, format: scenario.startsWith("travel") ? "in_person" : "meet", travel: { beforeMin: scenario.startsWith("travel") ? 15 : 0, afterMin: 0 },
    constraints: scenario.startsWith("guest-") ? { from: "2026-10-05", to: "2026-10-05", after: "12:00", before: "15:00" } : undefined,
    offered: scenario === "asked" ? [] : [{ start: "2026-10-06T12:00:00Z", end: "2026-10-06T12:30:00Z", account }] }, now, "request"));
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests[0]!;
  if (scenario === "booked") writeJson(join(home, "ledger.json"), { requests: [{ ...read(), status: "booked", eventId: "existing-meeting", booked: read().offered[0] }] });
  const event = { ...calendarEvent("inspected", scenario.endsWith("growth") ? "2026-10-05T10:00:00Z" : scenario === "travel-estimate" ? "2026-10-05T11:20:00Z" : scenario === "travel" ? "2026-10-05T11:45:00Z" : slot.start, scenario === "travel-estimate" ? "2026-10-05T11:30:00Z" : scenario === "travel" ? slot.start : "2026-10-05T15:00:00Z"), summary: "Private focus block" };
  const originalBlocker = structuredClone(event);
  const calendar = fakeCalendar([event]);
  const bridge = { token: "fixture", fetch: async (_url: unknown, init?: RequestInit) => {
    const { argv } = JSON.parse(String(init?.body)).params.arguments;
    const result = await calendar.command({ argv });
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: result.output }) }] } });
  } };
  if (scenario === "new-request") {
    writeJson(join(home, "ledger.json"), { requests: [] });
    const initial = await movableAction(owner, { action: "inspect", candidates: [slot], format: "meet", travel: { beforeMin: 0, afterMin: 0 } }, bridge);
    assert.equal(initial.requiresRequest, true, "an unsaved inspection must require context before asking");
    assert.equal(initial.askedAt, undefined);
    const created = addRequest({ requests: [] }, { origin: "owner", status: "asked", handle: "+15550002222", topic: "Lunch", durationMin: 30,
      format: "meet", travel: { beforeMin: 0, afterMin: 0 }, offered: [] }, now, "request");
    writeJson(join(home, "ledger.json"), updateRequest(recordDelivery(recordDelivery(created, "request", "start", "begin", now), "request", "start", "complete", now), "request", { chatUid: "guest-chat" }, now));
    assert.deepEqual(read().offered, []);
    assert.equal(calendar.calls.some(c => c[2] === "create"), false);
  }
  const twoChoices = scenario.endsWith("choice");
  const inspected = await movableAction(owner, { action: "inspect", requestId: "request", candidates: twoChoices ? [{ start: "2026-10-05T13:00:00Z", end: "2026-10-05T13:30:00Z" }, slot] : [slot], ...(scenario === "travel-estimate" ? { travel: { beforeMin: 45, afterMin: 0 } } : {}) }, bridge);
  assert.ok(inspected.askedAt, JSON.stringify(inspected));
  const pending = read().pendingOwner!;
  assert.equal(pendingOwnerList({ requests: [read()] }).length, 1);
  assert.ok("question" in pending && pending.overlap);
  assert.deepEqual(pending.overlap.choices[0]!.event, { account, id: "inspected" });
  if (scenario === "travel-estimate") assert.deepEqual(pending.overlap.travel, { beforeMin: 45, afterMin: 0 });
  const sent: string[] = [], send = async (_to: string, text: string) => { sent.push(text); if (scenario === "delivery-failure") throw new Error("unknown delivery"); };
  const args = { requestId: "request", askedAt: inspected.askedAt, text: "Private focus block", ...(twoChoices ? { overlapChoice: 1 } : {}), outcome: scenario === "refuse" ? "refuse_overlap" as const : "allow_overlap" as const };
  const options = { command: calendar.command, now: () => now };
  if (scenario === "prior-grant") writeJson(join(home, "ledger.json"), { requests: [{ ...read(), allowOverlap: [{ account, id: "unapproved" }] }] });
  const before = read();
  if (scenario === "new-request") assert.equal(readJson<Ledger>(join(home, "ledger.json"), { requests: [] }).requests.length, 1);
  assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 1 }, { ...args, outcome: "answer" }, send, options));
  assert.deepEqual(read(), before, "generic answers cannot consume overlap decisions");
  if (twoChoices) {
    assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 1 }, { ...args, overlapChoice: undefined }, send, options));
    assert.deepEqual(read(), before, "two candidates require an explicit choice");
  }
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
  if (scenario === "delivery-failure") {
    assert.ok("error" in result);
    assert.ok(read().pendingOwner?.answerAttemptedAt);
    const writes = calendar.calls.filter(c => c[2] === "create").length;
    assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 3 }, args, send, options));
    assert.equal(calendar.calls.filter(c => c[2] === "create").length, writes);
    assert.equal(sent.length, 1);
    return;
  }
  if (["same-title", "other-account", "revoked", "prior-grant"].includes(scenario)) {
    assert.ok("error" in result, JSON.stringify(result));
    assert.equal(sent.length, 0);
    assert.deepEqual(read().allowOverlap, before.allowOverlap);
    assert.deepEqual(read().offered, before.offered);
    assert.equal([...calendar.events.values()].filter(e => e.id.startsWith("new-") && e.status !== "cancelled").length, 0);
  } else {
    if (scenario.startsWith("email")) {
      assert.ok(result.email, JSON.stringify(result));
      assert.doesNotMatch(result.email.body, /Private|inspected|example.com/);
      const writes = calendar.calls.filter(c => c[2] === "create").length;
      if (twoChoices) assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 3 }, { ...args, overlapChoice: 0, emailSent: true }, send, options));
      assert.equal((await answerOwner({ ...owner, turnStartedAt: now + 3 }, { ...args, emailSent: true }, send, options) as any).answered, true);
      assert.equal(calendar.calls.filter(c => c[2] === "create").length, writes);
    } else assert.equal(result.answered, true, JSON.stringify(result));
    assert.equal(read().pendingOwner, undefined);
    assert.equal(read().status, before.status === "asked" ? "offered" : before.status, "overlap permission never books or moves");
    assert.deepEqual(read().booked, before.booked);
    assert.deepEqual(read().allowOverlap ?? [], scenario === "refuse" ? [] : [{ account, id: "inspected", ...slot }]);
    assert.equal(sent.length, scenario === "refuse" || scenario.startsWith("email") ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(sent), /Private|inspected|example.com/);
    assert.equal(readJson<any>(join(home, "overlap-decisions.json"), {})["private focus block"].allowed, scenario !== "refuse");
  }
  if (scenario.startsWith("guest-")) {
    const previousToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
    process.env.PLOW_MCP_BRIDGE_TOKEN = "fixture";
    t.after(() => { if (previousToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN; else process.env.PLOW_MCP_BRIDGE_TOKEN = previousToken; });
    t.mock.method(globalThis, "fetch", bridge.fetch);
    const held = read().offered;
    const replacement = await guestAction({ messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "guest-chat", requesterSenderId: "+15550002222" }, "other_times",
      { offer_week: false, from: "2026-10-05", to: "2026-10-05", after: "12:00", before: "15:00", ...(scenario === "guest-exact" ? { start: "2026-10-05T13:00:00Z" } : {}) }, async () => {});
    assert.ok("error" in replacement, JSON.stringify(replacement));
    assert.deepEqual(read().offered, held, "guest alternatives cannot inherit overlap permission");
  }
  if (["replacement", "clear-grant"].includes(scenario)) {
    const replacement = { start: `2026-10-05T${scenario === "replacement" ? "13" : "15"}:00:00Z`, end: `2026-10-05T${scenario === "replacement" ? "13" : "15"}:30:00Z` };
    const { origin, handle, chatUid, topic, durationMin, format, travel, constraints, allowOverlap } = read();
    const input = { origin, handle, chatUid, topic, durationMin, format, travel, constraints, allowOverlap, offered: [replacement] };
    if (scenario === "replacement") await assert.rejects(offerRequest({ ...input, requestId: "request" }, options), /previous offer retained/);
    else { await offerRequest({ ...input, requestId: "request" }, options); assert.deepEqual(read().allowOverlap, []); }
  }
  if (scenario.endsWith("growth")) {
    const previousToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
    process.env.PLOW_MCP_BRIDGE_TOKEN = "fixture";
    t.after(() => { if (previousToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN; else process.env.PLOW_MCP_BRIDGE_TOKEN = previousToken; });
    t.mock.method(globalThis, "fetch", bridge.fetch);
    const guest = { messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "guest-chat", requesterSenderId: "+15550002222" };
    if (scenario === "format-growth") assert.ok(!("error" in await guestAction(guest, "format", { format: "in_person", travel: { beforeMin: 120, afterMin: 120 } })));
    else await calendarAction("request", { action: "travel", travel: { beforeMin: 45, afterMin: 0, override: true } }, options);
    assert.deepEqual(read().allowOverlap, [], "expanded travel requires fresh overlap approval");
    const writes = calendar.calls.filter(c => ["create", "update"].includes(c[2]!)).length;
    const picked = await guestAction(guest, "pick", { start: slot.start });
    assert.ok("code" in picked && picked.code === "TIME_UNAVAILABLE", JSON.stringify(picked));
    await assert.rejects(calendarAction("request", { action: "book", start: slot.start }, options), /previous offer retained/);
    assert.equal(calendar.calls.filter(c => ["create", "update"].includes(c[2]!)).length, writes);
  }
  if (scenario === "wrong-interval") await assert.rejects(calendarAction("request", { action: "book", start: "2026-10-05T13:00:00Z", end: "2026-10-05T13:30:00Z" }, options), /previous offer retained/);
  if (scenario === "travel" || scenario === "travel-estimate") {
    await calendarAction("request", { action: "book", start: slot.start }, options);
    assert.equal(read().travelEvents?.length, 1);
    if (scenario === "travel-estimate") { assert.equal(read().travel.beforeMin, 45); assert.equal(calendar.events.get(read().travelEvents![0]!.holdId)!.start.dateTime, "2026-10-05T11:15:00.000Z"); }
    assert.deepEqual(read().allowOverlap, []);
    await calendarAction("request", { action: "cancel" }, options);
  }
  assert.deepEqual(calendar.events.get("inspected"), originalBlocker, "the approved blocker stays unchanged");
  const writes = calendar.calls.filter(c => ["create", "update", "delete"].includes(c[2]!)).length;
  assert.ok("error" in await answerOwner({ ...owner, turnStartedAt: now + 4 }, args, send, options), "a repeated answer cannot write over an unapproved blocker or replay a consumed decision");
  assert.equal(calendar.calls.filter(c => ["create", "update", "delete"].includes(c[2]!)).length, writes);
  t.diagnostic(JSON.stringify({ scenario, result, sent, allowed: read().allowOverlap }));
});
