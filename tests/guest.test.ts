import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerGuestTools } from "../plugin/guest-tools.js";
import type { Participant } from "../skills/meetly/scripts/owner-chat.ts";
import { offerOwnerGroup } from "../skills/meetly/scripts/owner-group.ts";
import { registerOwnerGroupTool, registerOwnerDmTool, registerContactTools } from "../plugin/owner-tools.js";
import { confirmContactOffer, contactPreference } from "../skills/meetly/scripts/contact-policy.ts";
import { pipeline, reserveNudges } from "../skills/meetly/scripts/pipeline.ts";
import plugin from "../plugin/index.js";
import { calendarAction, offerRequest } from "../skills/meetly/scripts/calendar.ts";
import { guestAction, type GuestAction, type GuestArgs, type GuestContext } from "../skills/meetly/scripts/guest.ts";
import { doNotContact, pendingOwnerList, expiredRequests, addRequest, type Ledger, type Request } from "../skills/meetly/scripts/ledger.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { withinConstraints } from "../skills/meetly/scripts/slots.ts";
import { DEFAULTS, SLOT_COUNT } from "../skills/meetly/scripts/config.ts";
import { calendarEvent as event, fakeCalendar, cli, tmpHome } from "./helpers.ts";

const now = Date.parse("2026-10-02T08:00:00Z");
const context = { messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "chat-one", requesterSenderId: "+15551234567", config: {} };
const offers = [
  { start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", holdId: "hold-one", account: "owner@example.com" },
  { start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", holdId: "hold-two", account: "owner@example.com" },
];
const actions: [GuestAction, GuestArgs][] = [
  ["view", {}], ["pick", { start: offers[0]!.start }], ["other_times", { offer_week: false, after: "11:00" }],
  ["format", { format: "meet" }], ["ask_owner", { question: "Which entrance?" }], ["decline", {}],
];

function fixture(t: TestContext, contactOutput = "S|0\nR|1|Guest||\nP|1|+15551234567||\nE|1|guest@example.net||", timezone = "UTC") {
  const home = tmpHome();
  const previousHome = process.env.MEETLY_HOME;
  const previousToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  const previousBase = process.env.PLOW_API_BASE, previousAgentToken = process.env.PLOW_AGENT_TOKEN;
  process.env.PLOW_API_BASE = "https://api.plow.test";
  process.env.PLOW_AGENT_TOKEN = "fixture";
  const participants: Participant[] = [
    { type: "agent", relationship: "self", line: { display_name: "Alder" } },
    { type: "member", role: "owner", display_name: "Alex", provider_key: "+15557654321" },
    { type: "member", role: "member", display_name: "Guest", provider_key: context.requesterSenderId },
  ];
  process.env.MEETLY_HOME = home;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "fixture";
  t.mock.method(Date, "now", () => now);
  const config = { ...DEFAULTS, ownerName: "Alex", timezone, defaultAccount: "owner@example.com",
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  const ledger = addRequest({ requests: [] }, {
    origin: "owner", handle: context.requesterSenderId, chatUid: context.nativeChannelId, name: "Guest", topic: "Lunch",
    durationMin: 30, constraints: { days: ["mon", "tue"], after: "10:00", before: "15:00", from: "2026-10-05", to: "2026-10-06" },
    allowOverlap: [{ account: "owner@example.com", id: "approved" }], offered: offers.map(o => ({ ...o })), format: "unknown", locale: "en-US",
  }, now, "request-one");
  const save = (value: Ledger) => writeJson(join(home, "ledger.json"), value);
  save(ledger);
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] });
  const { events, command } = fakeCalendar(offers.map(o => event(o.holdId!, o.start, o.end)));
  const commands: string[][] = [];
  const fail = new Set<string>();
  const lost = new Set<string>();
  const hooks: { before?: (argv: string[]) => Promise<void> } = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (String(_url).startsWith("https://api.plow.test/v1/chats/")) {
      assert.equal(init.redirect, "error");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer fixture");
      return Response.json({ uid: decodeURIComponent(String(_url).split("/").at(-1)!), status: "active", participants });
    }
    const call = JSON.parse(String(init.body));
    assert.equal(call.params.name, "plow_run_command");
    const argv: string[] = call.params.arguments.argv;
    commands.push(argv);
    await hooks.before?.(argv);
    let output: string;
    let exit_code = 0;
    if (fail.has(argv[2]!) || fail.has(argv[4]!)) { output = "PRIVATE BACKEND ERROR owner@example.com"; exit_code = 1; }
    else if (argv[0] === "/bin/sh") output = contactOutput;
    else {
      const result = await command({ argv });
      output = result.output ?? result.error!;
      if (result.error) exit_code = 1;
    }
    if (lost.has(argv[2]!)) return new Response("", { status: 503 });
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code, output }) }] } });
  });
  t.after(() => {
    assert.deepEqual(readJson(join(home, "config.json"), {}), config);
    const request = read().requests.find(r => r.id === "request-one");
    if (request) {
      assert.deepEqual(request.constraints, ledger.requests[0]!.constraints);
      assert.deepEqual(request.allowOverlap, request.booked ? [] : [{ account: "owner@example.com", id: "approved" }]);
      assert.equal(request.durationMin, ledger.requests[0]!.durationMin);
    }
  });
  t.after(() => {
    if (previousHome === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = previousHome;
    if (previousToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN; else process.env.PLOW_MCP_BRIDGE_TOKEN = previousToken;
    if (previousBase === undefined) delete process.env.PLOW_API_BASE; else process.env.PLOW_API_BASE = previousBase;
    if (previousAgentToken === undefined) delete process.env.PLOW_AGENT_TOKEN; else process.env.PLOW_AGENT_TOKEN = previousAgentToken;
    rmSync(home, { recursive: true, force: true });
  });
  const ownerLines: string[] = [];
  const deliveries: Record<string, any>[] = [];
  const routes: Record<string, any>[] = [];
  const delivery = { status: "sent", fail: false };
  const ownerRoute = { agentId: "main", sessionKey: "agent:main:main" };
  const sendOwner = async (text: string) => { ownerLines.push(text); };
  const outbound = async () => ({
    buildOutboundSessionContext: (args: object) => args,
    sendDurableMessageBatch: async (args: Record<string, any>) => {
      assert.ok(read().requests[0]!.pendingOwner || read().requests[0]!.booked || read().requests[0]!.status === "dropped", "save the question or booking change before sending");
      deliveries.push(args);
      if (delivery.fail) throw new Error("PRIVATE TRANSPORT ERROR");
      ownerLines.push(args.payloads[0].text);
      return { status: delivery.status };
    },
  });
  const tools = new Map<string, { parameters: { properties: Record<string, { description: string }> }; execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> }>();
  registerGuestTools({ runtime: { channel: {
    routing: { resolveAgentRoute(args: object) {
      assert.deepEqual(args, { cfg: context.config, channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } });
      return ownerRoute;
    } },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async (args: Record<string, any>) => { routes.push(args); } },
  } }, registerTool(factory: (ctx: GuestContext) => { name: string; parameters: { properties: Record<string, { description: string }> }; execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> }) {
    const tool = factory(context); tools.set(tool.name, tool);
  } }, (ctx, action, args, send) => guestAction({ ...ctx, turnStartedAt: now + 1 }, action, args, send), outbound);
  const act = (ctx: GuestContext, action: GuestAction, args: GuestArgs = {}) => guestAction({ turnStartedAt: now + 1, ...ctx }, action, args, sendOwner);
  return { home, read, save, ledger, participants, events, commands, fail, lost, hooks, tools, act, ownerLines, deliveries, routes, delivery, request: () => read().requests[0]! };
}

for (const [action, args] of actions) test(`${action} refuses missing or mismatched runtime sender/chat and ignores identity arguments`, async t => {
  const f = fixture(t);
  for (const ctx of [ {}, { ...context, requesterSenderId: "+15557654321" }, { ...context, nativeChannelId: "other-chat" },
    { ...context, messageChannel: "webchat" }, { ...context, agentAccountId: "email" },
    ...["+115551234567", "5551234567", "+15551234567junk"].map(requesterSenderId => ({ ...context, requesterSenderId })),
    { ...context, nativeChannelId: `plow:${context.nativeChannelId}` }]) {
    const result = await guestAction(ctx, action, { ...args, ...context, id: "request-one", handle: context.requesterSenderId } as GuestArgs);
    assert.match(JSON.stringify(result), /No scheduling request matches/);
  }
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.commands, []);
});

for (const [action, args] of actions) test(`${action} refuses an unlinked offer without claiming the current chat`, async t => {
  const f = fixture(t);
  delete f.ledger.requests[0]!.chatUid;
  f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "other", chatUid: "other-chat", handle: "+15557654321" });
  f.save(f.ledger);
  const result = await f.act(context, action, args);
  assert.match(JSON.stringify(result), /No scheduling request matches/);
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.commands, []);
});

test("other-times files a free outside-window approval without replacing holds", async t => {
  const args = { offer_week: false, start: "2026-10-05T20:00" };
  const f = fixture(t);
  f.ledger.requests[0]!.constraints!.before = "21:00";
  f.save(f.ledger);
  const tool = f.tools.get("meetly_other_times")!;
  const result = JSON.parse((await tool.execute("ask", args)).content[0]!.text);
  assert.equal(result.ownerAskSent, true);
  assert.equal(result.message, "I've asked Alex and will get back to you here when Alex replies.");
  assert.equal(result.askDetails, false);
  assert.deepEqual(f.request().offered, offers);
  assert.equal(f.request().status, "offered");
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-05T20:00:00+00:00", end: "2026-10-05T20:30:00+00:00", askedAt: new Date(now).toISOString() });
  assert.equal(f.deliveries.length, 1);
  assert.ok(f.commands.every(c => c[2] === "events"));
  const again = JSON.parse((await tool.execute("again", args)).content[0]!.text);
  assert.match(again.error, /already open/);
  assert.notEqual(again.ownerAskSent, true);
  assert.equal(f.deliveries.length, 1);
});

test("an exact in-window other-times request holds that time without asking the owner", async t => {
  const f = fixture(t);
  const result = await f.act(context, "other_times", { offer_week: false, start: "2026-10-05T11:15" });
  assert.ok(!("error" in result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, false);
  assert.deepEqual(f.request().offered.map(o => [o.start, o.end]), [["2026-10-05T11:15:00+00:00", "2026-10-05T11:45:00+00:00"]]);
  assert.equal(f.ownerLines.length, 0);
});

for (const reason of ["busy", "owner constraints"] as const) test(`an exact other-times request falls back when blocked by ${reason}`, async t => {
  const f = fixture(t);
  if (reason === "busy") f.events.set("conflict", event("conflict", "2026-10-05T11:15:00Z", "2026-10-05T11:45:00Z"));
  else { f.ledger.requests[0]!.constraints!.after = "12:00"; f.save(f.ledger); }
  const result = await f.act(context, "other_times", { offer_week: false, start: "2026-10-05T11:15" });
  assert.ok(!("error" in result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.ok(f.request().offered.every(o => o.start !== "2026-10-05T11:15:00+00:00"));
  assert.equal(f.ownerLines.length, 0);
});

test("guest date bounds survive fallback when the preferred clock time is unavailable", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = {};
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { offer_week: false, from: "2026-10-05", to: "2026-10-11", after: "20:00" });
  assert.ok(!("error" in result));
  assert.ok(f.request().offered.every(o => o.start.slice(0, 10) >= "2026-10-05" && o.start.slice(0, 10) <= "2026-10-11"));
  assert.equal(f.ownerLines.length, 0, "a broad preference is not an exact time approval");
});

test("other-times automatically sends a lunch-window approval even inside working hours", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "tue"] };
  f.ledger.requests[0]!.meal = "lunch";
  f.ledger.requests[0]!.durationMin = 60;
  f.save(f.ledger);
  const result = await f.tools.get("meetly_other_times")!.execute("ask", { offer_week: false,
    start: "2026-10-06T15:00",
  });
  assert.equal(JSON.parse(result.content[0]!.text).ownerAskSent, true);
  assert.equal(f.deliveries.length, 1);
  assert.match(f.ownerLines[0]!, /outside the meeting window/);
  assert.doesNotMatch(f.ownerLines[0]!, /working hours/);
  assert.deepEqual(f.request().offered, offers);
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-06T15:00:00+00:00", end: "2026-10-06T16:00:00+00:00", askedAt: new Date(now).toISOString() });
});

for (const failure of ["calendar", "delivery"] as const) test(`outside-window approval never claims an owner ask on ${failure}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "tue"] }; f.save(f.ledger);
  if (failure === "calendar") f.fail.add("events");
  if (failure === "delivery") f.delivery.status = "queued";
  const tool = f.tools.get("meetly_other_times")!;
  const result = JSON.parse((await tool.execute("ask", { offer_week: false, start: "2026-10-05T20:00" })).content[0]!.text);
  assert.ok(result.error);
  assert.notEqual(result.ownerAskSent, true);
  assert.equal(result.message, undefined);
  assert.equal(f.deliveries.length, failure === "delivery" ? 1 : 0);
  assert.deepEqual(f.request().offered, offers);
});

test("decline requires the guest's clear refusal, never an other-times refusal", () => {
  const descriptions = new Map<string, string>();
  registerGuestTools({ registerTool(factory: (ctx: object) => { name: string; description: string }) {
    const tool = factory(context); descriptions.set(tool.name, tool.description);
  } });
  assert.match(descriptions.get("meetly_decline")!, /Only use when the guest clearly declines the meeting/);
  assert.match(descriptions.get("meetly_decline")!, /A refusal from meetly_other_times is not a guest decline/);
  assert.match(descriptions.get("meetly_other_times")!, /automatically asks the owner/);
  assert.match(descriptions.get("meetly_other_times")!, /ownerAskSent is true/);
  assert.match(descriptions.get("meetly_other_times")!, /Never repeat the guest\'s proposed terms, even in a refusal/);
  assert.doesNotMatch(descriptions.get("meetly_other_times")!, /explain which preferences/);
  assert.match(descriptions.get("meetly_other_times")!, /ask for a specific date and time if needed/);
  assert.match(descriptions.get("meetly_ask_owner")!, /Never invent a question or turn your own uncertainty into a guest question/);
  assert.match(descriptions.get("meetly_ask_owner")!, /ownerAskSent is true/);
  assert.match(descriptions.get("meetly_ask_owner")!, /Do not paraphrase or add a guest-asks prefix/);
});

test("ordinary plugin tool factories retain context, have no identity arguments, and declare their contracts", () => {
  const names: string[] = [];
  plugin.register({ on() {}, registerTool(factory: (ctx: object) => { name: string; parameters: { properties: object; required: string[] } }) {
    const tool = factory(context); names.push(tool.name);
    if (tool.name === "meetly_ask_owner") {
      assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
      assert.deepEqual(tool.parameters.required, ["question"]);
    }
    if (!["meetly_offer_owner_group", "meetly_offer_owner_dm", "meetly_contact_preference"].includes(tool.name)) {
      assert.ok(!Object.keys(tool.parameters.properties).some(k => ["id", "handle", "chatUid", "sender", "account", "allowOverlap"].includes(k)));
      assert.equal("constraints" in tool.parameters.properties, tool.name === "meetly_answer_owner");
    }
  } });
  assert.deepEqual(names, JSON.parse(readFileSync(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8")).contracts.tools);
});

for (const preferences of [
  {},
  { from: "2026-10-05", to: "2026-10-07", after: "20:00" },
  { days: ["thu"], after: "20:00" },
]) test(`ruled-out Tuesdays stay excluded from replacement searches: ${JSON.stringify(preferences)}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-07", after: "10:00", before: "15:00" };
  f.save(f.ledger);
  f.events.set("monday", event("monday", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"));
  const result = await f.tools.get("meetly_other_times")!.execute("call", { offer_week: false, ...preferences, excludedDays: ["tue"] });
  const details = JSON.parse(result.content[0]!.text);
  assert.equal(details.error, undefined, JSON.stringify(details));
  assert.ok(details.offered.length > 0);
  assert.ok(details.offered.every((o: { start: string }) => o.start.startsWith("2026-10-07")), JSON.stringify(details.offered));
  assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-07")));
  t.diagnostic(`Replacement offer: ${JSON.stringify(details.offered)}`);
});

for (const args of [
  { excludedDays: ["funday"] },
  { excludedDays: ["mon", "tue"] },
  { excludedDays: ["tue"], start: offers[1]!.start },
]) test(`excluded weekdays cannot be bypassed: ${JSON.stringify(args)}`, async t => {
  const f = fixture(t);
  const before = f.read();
  const result = await f.tools.get("meetly_other_times")!.execute("call", { ...args, offer_week: false });
  assert.ok(JSON.parse(result.content[0]!.text).error);
  if (!args.excludedDays.includes("funday")) before.requests[0]!.excludedDays = args.excludedDays;
  if (JSON.parse(result.content[0]!.text).code === "NO_ALTERNATIVES") {
    assert.deepEqual(f.request().offered, before.requests[0]!.offered);
    assert.deepEqual(f.request().constraints, before.requests[0]!.constraints);
    assert.deepEqual(f.request().excludedDays, args.excludedDays);
    assert.ok(f.request().pendingOwner && "question" in f.request().pendingOwner!);
    assert.equal(f.ownerLines.length, 1);
  } else {
    assert.deepEqual(f.read(), before);
    assert.equal(f.ownerLines.length, 0);
  }
  assert.ok(f.commands.every(c => c[2] === "events"));
});

test("blank optional preferences through the guest tool still produce fresh held times", async t => {
  const f = fixture(t);
  const result = await f.tools.get("meetly_other_times")!.execute("call", { offer_week: false,
    from: "", to: "", after: "", before: "",
  });
  const details = JSON.parse(result.content[0]!.text);
  assert.equal(details.status, "offered", JSON.stringify(details));
  assert.equal(details.preferencesUnavailable, false);
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(["2026-10-05", "2026-10-06"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
    assert.ok(!offers.some(old => old.start === offer.start));
    assert.equal(f.events.get(offer.holdId!)!.status, "confirmed");
  }
  assert.ok(offers.every(old => f.events.get(old.holdId)!.status === "cancelled"));
});

test("pick books the chosen hold with fixed arguments, records the event, and deletes only the other holds", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.format = "meet"; f.save(f.ledger);
  const result = await f.tools.get("meetly_pick_time")!.execute("call", { start: offers[0]!.start, allowOverlap: ["intruder"], account: "intruder", topic: "intruder" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|owner@example.com|https:\/\/meet/);
  const request = f.request();
  assert.equal(request.status, "booked"); assert.equal(request.eventId, "hold-one");
  assert.deepEqual(request.booked, { start: offers[0]!.start, end: offers[0]!.end, account: "owner@example.com" });
  assert.equal(request.meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(request.holdCleanup, []);
  const update = f.commands.find(c => c[2] === "update")!;
  assert.deepEqual(update.slice(0, 5), ["plow-gog", "calendar", "update", "primary", "hold-one"]);
  for (const [flag, value] of [["--summary", "Lunch with Guest"], ["--from", offers[0]!.start], ["--to", offers[0]!.end],
    ["--account", "owner@example.com"], ["--send-updates", "all"], ["--attendees", "guest@example.net"]]) assert.equal(update[update.indexOf(flag!) + 1], value);
  assert.ok(update.includes("--with-meet"));
  assert.match(update[update.indexOf("--private-prop") + 1]!, /^meetlyOperation=/);
  assert.deepEqual(f.commands.filter(c => c[2] === "delete"), [["plow-gog", "calendar", "delete", "primary", "hold-two", "--send-updates", "none", "--force", "--account", "owner@example.com"]]);
});

test("pick never invites a contact whose local number only shares the guest's suffix", async t => {
  // With the Mac's region known (#51), a full national number is the guest's own;
  // a card holding only the trailing digits still never gets the invite.
  const f = fixture(t, "L|en_US\nS|0\nR|1|Other|Person|\nP|1|123-4567||\nE|1|wrong@example.net||");
  const result = await guestAction(context, "pick", { start: offers[0]!.start });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().status, "booked");
  assert.equal("invitationSent" in result && result.invitationSent, false);
  const update = f.commands.find(c => c[2] === "update")!;
  assert.ok(update);
  assert.ok(!update.includes("--attendees"));
  assert.doesNotMatch(JSON.stringify(f.commands), /wrong@example.net/);
});

for (const allowed of [true, false]) test(`pick rechecks conflicts; owner-approved=${allowed}`, async t => {
  const f = fixture(t);
  f.events.set("conflict", event(allowed ? "approved" : "not-approved", offers[0]!.start, offers[0]!.end));
  f.events.get("hold-one")!.status = "cancelled";
  const result = await guestAction(context, "pick", { start: offers[0]!.start, allowOverlap: ["not-approved"] } as GuestArgs);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|not-approved|owner@example.com/);
  assert.equal(f.request().status, allowed ? "booked" : "offered");
  const writes = f.commands.filter(c => ["create", "update", "delete"].includes(c[2]!));
  if (allowed) assert.ok(writes[0]!.includes("--confirm-conflict"));
  else assert.deepEqual(writes, []);
});

test("other times intersect guest preferences with owner conditions and replace holds with a cleanup retry record", async t => {
  const f = fixture(t); f.fail.add("hold-two");
  const result = await guestAction(context, "other_times", { offer_week: false, days: ["mon", "tue", "wed"], after: "09:00", before: "12:00", from: "2026-10-01", to: "2026-10-31" });
  assert.ok(!("error" in result), JSON.stringify(result));
  const request = f.request();
  assert.equal(request.status, "offered"); assert.equal(request.offered.length, 3);
  for (const offer of request.offered) {
    assert.ok(["2026-10-05", "2026-10-06"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "12:00");
    assert.ok(!offers.some(old => Date.parse(old.start) === Date.parse(offer.start)));
  }
  assert.deepEqual(request.holdCleanup, [{ holdId: "hold-two", account: "owner@example.com" }]);
  assert.equal(f.events.get("hold-one")!.status, "cancelled");
  for (const argv of f.commands.filter(c => c[2] === "create")) {
    assert.equal(argv[argv.indexOf("--send-updates") + 1], "none");
    assert.ok(!argv.includes("--attendees")); assert.ok(!argv.includes("--confirm-conflict"));
  }
});

test("decline drops the open request, clears approval, deletes holds and queues failed deletes", async t => {
  const f = fixture(t); f.fail.add("hold-two");
  f.ledger.requests[0]!.pendingOwner = { start: "2026-10-05T20:00:00Z", end: "2026-10-05T20:30:00Z", askedAt: new Date(now).toISOString() }; f.save(f.ledger);
  const result = await guestAction(context, "decline");
  assert.equal("message" in result && result.message, "I've cancelled this scheduling request.");
  assert.equal(f.request().status, "dropped"); assert.equal(f.request().pendingOwner, undefined);
  assert.deepEqual(f.request().holdCleanup, [{ holdId: "hold-two", account: "owner@example.com" }]);
  assert.equal(f.commands.filter(c => c[2] === "delete").length, 2);
});

test("an outside-hours refusal can proceed to owner approval without dropping or booking the request", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints!.before = "21:00";
  f.save(f.ledger);
  for (const date of ["2026-10-05", "2026-10-06"]) f.events.set(date, event(date, `${date}T09:00:00Z`, `${date}T18:00:00Z`));
  const refused = await guestAction(context, "other_times", { offer_week: false, after: "20:00" });
  assert.ok("error" in refused);
  assert.deepEqual(f.read(), f.ledger);
  const result = await f.act(context, "other_times", { offer_week: false, start: "2026-10-05T20:00" });
  assert.ok(!("error" in result)); assert.equal(f.request().status, "offered");
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-05T20:00:00+00:00", end: "2026-10-05T20:30:00+00:00", askedAt: new Date(now).toISOString() });
  assert.ok(f.commands.every(c => c[2] === "events"));
  assert.equal(f.ownerLines.length, 1);
});

test("format before and after booking updates the event and records only the backend Meet link", async t => {
  const f = fixture(t);
  await guestAction(context, "format", { format: "in_person", location: "Library" });
  assert.equal(f.commands.length, 0); assert.equal(f.request().location, "Library");
  await guestAction(context, "pick", { start: offers[0]!.start });
  assert.equal(f.events.get("hold-one")!.location, "Library");
  f.commands.length = 0;
  const result = await guestAction(context, "format", { format: "meet" });
  assert.equal(f.request().format, "meet"); assert.equal(f.request().meetUrl, "https://meet.google.com/abc-defg-hij");
  const writes = f.commands.filter(c => c[2] === "update");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![4], "hold-one");
  assert.ok(writes[0]!.includes("--with-meet"));
  assert.ok(writes[0]!.includes("--location="));
  assert.equal(f.events.get("hold-one")!.location, "");
  assert.equal(f.request().location, "");
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/meet|PRIVATE/);
});

for (const status of ["dropped", "expired"] as const) test(`${status} stays this chat's request; guest cannot rebook or cancel it`, async t => {
  const f = fixture(t); f.ledger.requests[0]!.status = status; f.ledger.requests[0]!.format = "phone"; f.save(f.ledger);
  for (const [action, args] of actions.filter(([a]) => a !== "format")) {
    const result = await f.act(context, action, args);
    assert.equal((result as { status: string }).status, status);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.read(), f.ledger);
});

test("calendar failure leaks no event data and leaves the offer untouched", async t => {
  const f = fixture(t); f.fail.add("events");
  for (const action of ["pick", "other_times"] as const) {
    const result = await guestAction(context, action, { offer_week: false, start: offers[0]!.start });
    assert.ok("error" in result); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|owner@example.com/);
  }
  assert.deepEqual(f.read(), f.ledger);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

for (const scenario of ["different open request in chat", "sender offer linked elsewhere", "unapproved asked request"]) test(`all tools refuse ${scenario}`, async t => {
  const f = fixture(t);
  if (scenario === "different open request in chat") f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "different", handle: "+15557654321" });
  else if (scenario === "sender offer linked elsewhere") {
    f.ledger.requests[0]!.chatUid = "another-chat";
    f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "closed", status: "booked", chatUid: context.nativeChannelId, handle: "+15557654321" });
  } else { f.ledger.requests[0]!.status = "asked"; delete f.ledger.requests[0]!.chatUid; }
  f.save(f.ledger);
  for (const [action, args] of actions) assert.match(JSON.stringify(await guestAction(context, action, args)), /No scheduling request matches/);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.read(), f.ledger);
});

test("an unlinked replacement cannot be claimed from a closed group", async t => {
  const f = fixture(t);
  delete f.ledger.requests[0]!.chatUid;
  f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "old", status: "dropped", chatUid: context.nativeChannelId }); f.save(f.ledger);
  const result = await guestAction({ ...context, nativeChannelId: undefined, deliveryContext: { to: `plow:${context.nativeChannelId}` } }, "format", { format: "phone" });
  assert.equal((result as { status: string }).status, "dropped");
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.commands, []);
});

test("pick cannot bypass the current offer", async t => {
  const f = fixture(t);
  const start = "2026-10-05T12:00:00Z";
  f.events.set("conflict", event("private", start, start.replace(":00:00Z", ":30:00Z")));
  const result = await guestAction(context, "pick", { start });
  assert.ok("error" in result); assert.deepEqual(f.read(), f.ledger);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

for (const { name, ownerConstraints, guestArgs, busy, expectedDates } of [
  { name: "weekday without date bounds", ownerConstraints: { days: ["mon", "tue"], from: "2026-10-05", to: "2026-10-06", after: "10:00", before: "15:00" },
    guestArgs: { days: ["thu"], after: "16:00", before: "18:00" }, expectedDates: ["2026-10-05", "2026-10-06"] },
  { name: "Thursday outside owner date bounds", ownerConstraints: { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-07", after: "10:00", before: "15:00" },
    guestArgs: { days: ["thu"], from: "2026-10-08", to: "2026-10-08", after: "16:00", before: "18:00" }, expectedDates: ["2026-10-05", "2026-10-06", "2026-10-07"] },
  { name: "unavailable guest week", ownerConstraints: { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-14", after: "10:00", before: "15:00" },
    guestArgs: { from: "2026-10-05", to: "2026-10-11" }, busy: { start: "2026-10-05T00:00:00Z", end: "2026-10-12T00:00:00Z" }, expectedDates: ["2026-10-12", "2026-10-13", "2026-10-14"] },
]) test(`owner-condition fallback: ${name}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = ownerConstraints; f.save(f.ledger);
  if (busy) f.events.set("busy", event("busy", busy.start, busy.end));
  const result = await f.act(context, "other_times", { ...guestArgs, offer_week: false });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.deepEqual(f.request().constraints, ownerConstraints);
  assert.equal(f.request().status, "offered");
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(expectedDates.includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
    assert.ok(!offers.some(old => Date.parse(old.start) === Date.parse(offer.start)));
  }
  assert.ok(offers.every(old => f.events.get(old.holdId)!.status === "cancelled"));
  assert.equal(f.ownerLines.length, 0);
});

test("no fallback availability leaves the existing offer and holds intact", async t => {
  const f = fixture(t);
  f.events.set("busy", event("busy", "2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z"));
  const result = await guestAction(context, "other_times", { offer_week: false, days: ["wed"] });
  assert.ok("error" in result); assert.deepEqual(f.read(), f.ledger);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

test("a booking write refusal never triggers an unchecked conflict override", async t => {
  const f = fixture(t); f.fail.add("update");
  const result = await guestAction(context, "pick", { start: offers[0]!.start });
  assert.ok("error" in result); assert.deepEqual(f.request().offered, f.ledger.requests[0]!.offered);
  assert.equal(f.request().status, "offered");
  assert.equal(f.commands.filter(c => c[2] === "update").length, 1);
  assert.ok(f.commands.every(c => !c.includes("--confirm-conflict") && c[2] !== "delete"));
});

for (const start of ["2026-10-05T09:00:00Z", "2026-10-05T20:00:00Z", "2026-10-07T10:00:00Z"]) test(`a stale offer cannot bypass owner conditions or working hours: ${start}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.offered = [{ ...offers[0]!, start, end: start.replace(":00:00Z", ":30:00Z") }]; f.save(f.ledger);
  const result = await guestAction(context, "pick", { start });
  assert.ok("error" in result); assert.deepEqual(f.read(), f.ledger);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

test("a failed booked-format write leaves the stored format and booking intact", async t => {
  const f = fixture(t);
  await guestAction(context, "pick", { start: offers[0]!.start });
  const before = f.read(); f.fail.add("update");
  const result = await guestAction(context, "format", { format: "meet" });
  assert.ok("error" in result); assert.deepEqual(f.read(), before);
});


test("replacement times overlap only the request's old holds until the new offer commits", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.durationMin = 60;
  f.ledger.requests[0]!.offered = offers.map(o => ({ ...o, end: o.end.replace("10:30", "11:00") }));
  for (const e of f.events.values()) e.end.dateTime = e.end.dateTime.replace("10:30", "11:00");
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { offer_week: false, after: "10:30", before: "11:30" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().offered.length, 2);
  assert.ok(f.request().offered.every(o => o.start.slice(11, 16) === "10:30"));
  assert.ok(f.commands.filter(c => c[2] === "create").every(c => c.includes("--confirm-conflict")));
  assert.equal(f.events.get("hold-one")!.status, "cancelled");
});

test("guest location text cannot become a Latch conflict-override flag", async t => {
  const f = fixture(t);
  await guestAction(context, "format", { format: "in_person", location: "--confirm-conflict" });
  const result = await guestAction(context, "pick", { start: offers[0]!.start });
  assert.ok(!("error" in result));
  const command = f.commands.find(c => c[2] === "update")!;
  assert.ok(!command.includes("--confirm-conflict"));
  assert.ok(command.includes("--location=--confirm-conflict"));
});

test('canonical email equality is case insensitive but never suffix based', async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.handle = 'Guest@Example.com'; f.save(f.ledger);
  assert.ok(!('error' in await guestAction({ ...context, requesterSenderId: 'guest@example.com' }, 'view')));
  assert.match(JSON.stringify(await guestAction({ ...context, requesterSenderId: 'otherguest@example.com' }, 'view')), /No scheduling request matches/);
});

test('a failed replacement through the writer preserves the original offer and live holds', async t => {
  const f = fixture(t); f.fail.add('create');
  const result = await guestAction(context, 'other_times', { offer_week: false, after: '11:00' });
  assert.ok('error' in result);
  assert.deepEqual(f.request().offered, offers);
  assert.equal(f.events.get('hold-one')!.status, 'confirmed');
  assert.equal(f.events.get('hold-two')!.status, 'confirmed');
  assert.ok(f.commands.every(c => c[2] !== 'delete'));
});

for (const action of ['pick', 'other_times'] as const) test(`guest ${action} reconciles a lost write response through the writer`, async t => {
  const f = fixture(t); f.lost.add(action === 'pick' ? 'update' : 'create');
  const result = await guestAction(context, action, action === 'pick' ? { start: offers[0]!.start } : { offer_week: false, after: '11:00' });
  assert.ok(!('error' in result), JSON.stringify(result));
  assert.ok(f.request().calendarRevision);
  if (action === 'pick') {
    assert.equal(f.request().status, 'booked');
    assert.equal(f.commands.filter(c => c[2] === 'update').length, 1);
  } else {
    assert.equal(f.request().offered.length, 3);
    assert.equal(f.commands.filter(c => c[2] === 'create').length, 3);
  }
});

test('a concurrent owner booking cannot turn a stale guest pick into a reschedule', async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.before = async argv => {
    if (argv[2] === 'events') { f.hooks.before = undefined; entered(); await gate; }
  };
  const guest = guestAction(context, 'pick', { start: offers[0]!.start });
  await waiting;
  await calendarAction('request-one', { action: 'book', start: offers[1]!.start });
  release();
  assert.ok('error' in await guest);
  assert.equal(f.request().eventId, 'hold-two');
  assert.equal(f.request().booked!.start, offers[1]!.start);
  assert.equal(f.commands.filter(c => c[2] === 'update').length, 1);
});


test('an offered format change waits for a concurrent booking and cannot change its snapshot', async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.before = async argv => {
    if (argv[2] === 'update') { f.hooks.before = undefined; entered(); await gate; }
  };
  const booking = guestAction(context, 'pick', { start: offers[0]!.start });
  await waiting;
  const changing = guestAction(context, 'format', { format: 'meet' });
  release();
  assert.ok(!('error' in await booking));
  assert.ok('error' in await changing);
  assert.equal(f.request().format, 'unknown');
  assert.equal(f.request().meetUrl, undefined);
  assert.equal(f.events.get('hold-one')!.hangoutLink, undefined);
  assert.equal(f.commands.filter(c => c[2] === 'update').length, 1);
});

test('formatted full phone identity matches exactly and survives canonical ledger saves', async t => {
  const f = fixture(t);
  const result = await guestAction({ ...context, requesterSenderId: '+1 (555) 123-4567' }, 'view');
  assert.ok(!('error' in result), JSON.stringify(result));
  f.ledger.requests[0]!.handle = '+1 (555) 123-4567'; f.save(f.ledger);
  assert.ok(!('error' in await guestAction(context, 'view')));
});

test("ask-owner sends the human question verbatim to the fixed owner DM and mirrors the owner session", async t => {
  const f = fixture(t);
  const question = '  “Which  entrance?\n'.padEnd(497, 'x') + '”  ';
  assert.equal(question.length, 500);
  const result = await f.tools.get("meetly_ask_owner")!.execute("ask", { question, to: "intruder", chatUid: "intruder" });
  assert.doesNotMatch(JSON.stringify(result), /error|intruder/);
  const reply = JSON.parse(result.content[0]!.text);
  assert.equal(reply.silent, true);
  assert.equal(reply.ownerAskSent, true);
  assert.equal(reply.message, undefined);
  const saved = { question, askedAt: new Date(now).toISOString() };
  assert.deepEqual(f.request().pendingOwner, saved);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.ownerLines, [`Guest asked in your Lunch thread. Guest question: ${JSON.stringify(saved.question)}. Reply there, or tell me what to say.`]);
  assert.doesNotMatch(f.ownerLines[0]!, /chat-one|request-one|plow_reply_to|ledger|owner@example.com/);
  assert.deepEqual(f.deliveries, [{
    cfg: {}, channel: "plow", accountId: "chat", to: "plow-owner", payloads: [{ text: f.ownerLines[0] }],
    session: { cfg: {}, agentId: "main", sessionKey: "agent:main:main", conversationType: "direct" },
    mirror: { agentId: "main", sessionKey: "agent:main:main" }, skipQueue: true,
  }]);
  assert.deepEqual(f.routes, [{ storePath: "/sessions", sessionKey: "agent:main:main", channel: "plow", accountId: "chat", to: "plow-owner", createIfMissing: true }]);
  const view = await guestAction(context, "view");
  assert.deepEqual((view as { pendingOwner: object }).pendingOwner, { question: saved.question });
});

test("questions and time approvals share one slot, including concurrent asks", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints!.before = "21:00";
  f.save(f.ledger);
  const ask = f.tools.get("meetly_ask_owner")!;
  const times = f.tools.get("meetly_other_times")!;
  const results = await Promise.all([times.execute("one", { offer_week: false, start: "2026-10-05T20:00" }), ask.execute("two", { question: "Which project?" })]);
  assert.equal(results.filter(r => /error/.test(r.content[0]!.text)).length, 1);
  assert.equal(f.deliveries.length, 1);
  const pending = f.request().pendingOwner;
  const result = await times.execute("three", { offer_week: false, start: "2026-10-06T20:00" });
  assert.match(result.content[0]!.text, /already open/);
  assert.deepEqual(f.request().pendingOwner, pending);
});

for (const failure of ["unknown", "throw"] as const) test(`ask-owner ${failure} keeps the pending slot and never retries or claims delivery`, async t => {
  const f = fixture(t);
  f.delivery.status = "queued";
  f.delivery.fail = failure === "throw";
  const ask = f.tools.get("meetly_ask_owner")!;
  const result = await ask.execute("one", { question: "Which project?" });
  assert.match(result.content[0]!.text, /could not confirm delivery/);
  assert.equal(JSON.parse(result.content[0]!.text).silent, true);
  assert.doesNotMatch(result.content[0]!.text, /PRIVATE/);
  assert.ok(f.request().pendingOwner);
  assert.match((await ask.execute("two", { question: "Which project?" })).content[0]!.text, /already open/);
  assert.equal(f.deliveries.length, 1);
});

test("ask-owner rejects malformed or unscoped questions without sending", async t => {
  const f = fixture(t);
  const ask = f.tools.get("meetly_ask_owner")!;
  for (const args of [{}, { question: " " }, { question: 123 }, { start: "2026-10-05T20:00" }]) {
    assert.match((await ask.execute("bad", args)).content[0]!.text, /error/);
  }
  assert.match(JSON.stringify(await f.act({ ...context, nativeChannelId: "other-chat" }, "ask_owner", { question: "Where?" })), /No scheduling request matches/);
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.ownerLines, []);
  assert.deepEqual(f.commands, []);
});

test("a booked meeting can ask the owner even when the guest has an offer in another chat", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.status = "booked";
  f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "other", status: "offered", chatUid: "other-chat" });
  f.save(f.ledger);
  const result = await f.tools.get("meetly_ask_owner")!.execute("ask", { question: "Which entrance?" });
  assert.doesNotMatch(result.content[0]!.text, /error/);
  assert.equal(f.request().status, "booked");
  assert.deepEqual(f.commands, []);
  assert.equal(f.deliveries.length, 1);
});


test('an open owner question survives booking and format commits through the seam', async t => {
  const f = fixture(t);
  await f.tools.get('meetly_ask_owner')!.execute('ask', { question: 'Which entrance?' });
  const pending = f.request().pendingOwner;
  assert.ok(!('error' in await f.act(context, 'pick', { start: offers[0]!.start })));
  assert.equal(f.request().status, 'booked');
  assert.deepEqual(f.request().pendingOwner, pending);
  const revision = f.request().calendarRevision;
  assert.ok(revision);
  assert.ok(!('error' in await f.act(context, 'format', { format: 'meet' })));
  assert.notEqual(f.request().calendarRevision, revision);
  assert.deepEqual(f.request().pendingOwner, pending);
  assert.equal(f.deliveries.length, 1);
});


test("the owner tool records the runtime chat uid and refuses another group's claim", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  f.events.clear();
  let tool: any;
  const ctx = { ...context, senderIsOwner: true, requesterSenderId: "plow-owner",
    sessionKey: "agent:main:plow:group:cht_mixed", nativeChannelId: "cht_MiXeD" };
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory(ctx); } }, offerOwnerGroup);
  assert.equal(tool.parameters.properties.chatUid, undefined);
  assert.equal(tool.parameters.properties.handle, undefined);
  assert.equal(tool.parameters.properties.name.type, "string");
  const args = { introduction: "needed", handle: context.requesterSenderId, topic: "Planning", name: "", format: "", location: "", locale: "", durationMin: 30, offered: offers.map(({ start, end }) => ({ start, end, account: "injected@example.net", holdId: "injected-hold" })), chatUid: "other-group" };
  const result = await tool.execute("offer", args);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.request().chatUid, "cht_MiXeD");
  assert.equal(f.request().origin, "owner-group");
  assert.equal(f.request().durationMin, DEFAULTS.durationMin);
  assert.ok(f.request().offered.every(o => o.account === "owner@example.com" && o.holdId !== "injected-hold"));
  assert.equal(result.details.ownerName, "Alex");
  assert.equal(result.details.offered.length, SLOT_COUNT);
  assert.equal(result.content[0].text, JSON.stringify(result.details));
  assert.doesNotMatch(JSON.stringify(result), /account|holdId|calendarRevision|chatUid|example\.com|injected|new-\d|r_[a-f0-9]/);
  assert.equal(tool.parameters.properties.offered, undefined);
  assert.ok(!tool.parameters.required.includes("offered"));
  assert.ok(tool.parameters.required.includes("durationMin"));
  assert.deepEqual(tool.parameters.properties.constraints.properties.days.items.enum, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(tool.parameters.properties.constraints.properties.after.description, "Earliest time, HH:MM.");
  assert.equal(tool.parameters.properties.proposed.properties, tool.parameters.properties.constraints.properties);
  assert.equal(f.request().constraints, undefined);
  assert.equal(f.request().proposed, undefined);
  assert.ok("error" in await guestAction({ ...context, nativeChannelId: "other-group" }, "view"));
  assert.ok("error" in await guestAction({ ...context, nativeChannelId: "cht_mixed" }, "view"));
  assert.ok(!("error" in await guestAction({ ...context, nativeChannelId: "cht_MiXeD" }, "view")));
});

test("owner-group computes slots from saved policy and ignores guest-injected offered intervals", async t => {
  const f = fixture(t);
  const saved = f.ledger.requests[0]!;
  saved.constraints = { days: ["tue"], from: "2026-10-06", to: "2026-10-06", after: "11:00", before: "14:00" };
  saved.durationMin = 45;
  f.save(f.ledger);
  f.events.clear();
  f.events.set("busy", event("busy", "2026-10-06T11:00:00Z", "2026-10-06T12:00:00Z"));
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const injected = [
    { start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:30:00Z" },
    { start: "2026-10-02T08:30:00Z", end: "2026-10-02T09:00:00Z" },
    { start: "2026-10-03T10:00:00Z", end: "2026-10-03T10:30:00Z" },
    { start: "2026-10-05T20:00:00Z", end: "2026-10-05T23:00:00Z" },
  ];
  const result = await tool.execute("offer", { introduction: "needed", topic: "Planning", durationMin: saved.durationMin, proposed: { days: ["sat"], after: "20:00" }, offered: injected });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.details.preferencesUnavailable, true);
  assert.ok(f.request().offered.length > 0);
  for (const slot of f.request().offered) {
    assert.ok(slot.start.startsWith("2026-10-06T"));
    assert.ok(slot.start.slice(11, 16) >= "12:00" && slot.end.slice(11, 16) <= "14:00");
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), 45 * 60_000);
  }
  assert.equal(tool.parameters.properties.offered, undefined);
  assert.ok(!tool.parameters.required.includes("offered"));
  const before = f.read(), creates = f.commands.filter(c => c[2] === "create").length;
  f.fail.add("events");
  assert.equal((await tool.execute("retry", { topic: "Planning", offered: injected })).isError, true);
  assert.deepEqual(f.read(), before);
  assert.equal(f.commands.filter(c => c[2] === "create").length, creates);
});

test("the owner-group tool refuses guests, DMs and requests already linked elsewhere", async t => {
  const f = fixture(t);
  const args = { ...f.ledger.requests[0]!, offered: offers.map(({ holdId, ...slot }) => slot) };
  const ctx = { ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" };
  for (const invalid of [{ ...ctx, senderIsOwner: false }, { ...ctx, sessionKey: "agent:main:main" },
    { ...ctx, requesterSenderId: undefined }, { ...ctx, messageChannel: "webchat" },
    { ...ctx, nativeChannelId: undefined }, { ...ctx, agentAccountId: "email" }, { ...ctx, nativeChannelId: "elsewhere" }]) {
    assert.ok("error" in await offerOwnerGroup(invalid, args));
  }
  delete f.ledger.requests[0]!.chatUid;
  f.save(f.ledger);
  assert.ok("error" in await offerOwnerGroup(ctx, args));
  assert.deepEqual(f.read(), f.ledger);
  assert.equal(f.commands.length, 0);
});


test("owner-group ignores injected overlap permission before creating holds", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  f.events.clear();
  for (const [i, slot] of offers.entries()) f.events.set(`private-${i}`, { ...event(`private-${i}`, slot.start, slot.end), summary: "Weekly Claw" });
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const result = await tool.execute("offer", { introduction: "needed", topic: "Lunch", durationMin: 30, allowOverlapTitles: ["Weekly Claw"],
    allowOverlap: [{ account: "owner@example.com", id: "private-0" }], offered: offers,
    constraints: { from: "2026-10-05", to: "2026-10-05", after: "10:00", before: "10:30" } });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(f.commands.filter(c => c[2] === "create").length, 0);
  assert.deepEqual(f.read().requests, []);
  assert.equal(tool.parameters.properties.allowOverlap, undefined);
  assert.equal(tool.parameters.properties.allowOverlapTitles, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-|Weekly Claw|allowOverlap|owner@example.com/);
});

test("owner DM offers still resolve named overlap permission", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify({ origin: "owner", status: "asked",
    handle: context.requesterSenderId, topic: "Lunch", durationMin: 45, offered: [] })], { MEETLY_HOME: f.home });
  assert.equal(saved.status, 0, saved.stderr);
  f.events.clear();
  for (const [i, slot] of offers.entries()) f.events.set(`private-approved-${i}`, { ...event(`private-approved-${i}`, slot.start, slot.end), summary: "Weekly Claw" });
  f.events.set("private-unapproved", { ...event("private-unapproved", offers[1]!.start, offers[1]!.end), summary: "Weekly Claw extra" });
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("offer", { origin: "owner", handle: context.requesterSenderId, topic: "Lunch",
    allowOverlapTitles: ["Weekly Claw"], offered: offers.map(({ start }) => ({ start, end: new Date(Date.parse(start) + 45 * 60_000).toISOString() })) });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(tool.parameters.properties.durationMin, undefined);
  const { request } = result.details as { request: Request };
  assert.equal(request.durationMin, 45);
  assert.deepEqual(request.allowOverlap, ["private-approved-0", "private-approved-1"].map(id => ({ account: "owner@example.com", id })));
  assert.deepEqual(request.offered.map(o => o.start), [offers[0]!.start]);
  const creates = f.commands.filter(c => c[2] === "create");
  assert.equal(creates.length, 1);
  assert.ok(creates[0]!.includes("--confirm-conflict"));
  assert.equal(f.request().status, "offered");
  assert.equal(f.request().booked, undefined);
  assert.ok(creates[0]![creates[0]!.indexOf("--summary") + 1]!.startsWith("Hold:"));
  assert.equal(cli("ledger.ts", ["update", "--id", request.id, "--json", JSON.stringify({ chatUid: context.nativeChannelId })], { MEETLY_HOME: f.home }).status, 0);
  const chosen = await f.act(context, "pick", { start: request.offered[0]!.start });
  assert.equal("status" in chosen && chosen.status, "booked");
  assert.equal("overlappedWithOwnerApproval" in chosen && chosen.overlappedWithOwnerApproval, true);
});

test("owner-group binds a same-handle unlinked asked request and the guest can book", async t => {
  const f = fixture(t);
  const asked = f.ledger.requests[0]!;
  Object.assign(asked, { origin: "inbound", status: "asked", sourceRowid: 42, offered: [] });
  delete asked.chatUid;
  delete asked.offeredAt;
  asked.name = "Tia";
  f.participants[2]!.display_name = "unnamed member";
  f.hooks.before = async argv => { if (argv[0] === "/bin/sh") throw new Error("Contacts unavailable"); };
  f.save(f.ledger);
  f.events.clear();
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { topic: asked.topic, durationMin: asked.durationMin, constraints: asked.constraints });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.read().requests.length, 1);
  assert.equal(f.request().id, asked.id);
  assert.equal(f.request().sourceRowid, 42);
  assert.equal(f.request().name, "Tia");
  assert.ok(f.commands.filter(c => c[2] === "create").every(c => c[c.indexOf("--summary") + 1] === "Hold: Lunch with Tia"));
  assert.equal(f.request().status, "offered");
  assert.equal(f.request().chatUid, context.nativeChannelId);
  assert.equal(f.commands.filter(c => c[2] === "create").length, SLOT_COUNT);
  assert.ok(!("error" in await f.act(context, "pick", { start: f.request().offered[0]!.start })));
  assert.equal(f.request().status, "booked");
  const booking = f.commands.find(c => c[2] === "update")!;
  assert.equal(booking[booking.indexOf("--summary") + 1], "Lunch with Tia");
});

for (const [askDetails, format, location, expected] of [
  [false, "unknown", undefined, false], [false, "in_person", undefined, false],
  [undefined, "unknown", undefined, true], [undefined, "in_person", "  ", true],
  [undefined, "meet", undefined, false], [undefined, "phone", undefined, false], [undefined, "in_person", "Library", false],
] as const) test(`request view reserves details once: ${askDetails}, ${format}, ${location}`, async t => {
  const f = fixture(t);
  Object.assign(f.ledger.requests[0]!, { askDetails, format, location }); f.save(f.ledger);
  const first = cli("request-view.ts", ["--id", "request-one"], { MEETLY_HOME: f.home }).json;
  assert.equal(first.askDetails, expected);
  assert.equal(!!f.request().detailsAskedAt, expected);
  const reloaded = await import(new URL(`../skills/meetly/scripts/guest.ts?details=${askDetails}-${format}-${location}`, import.meta.url).href);
  assert.equal((await reloaded.guestAction(context, "view")).askDetails, false);
  assert.ok(!("error" in await guestAction(context, "other_times", { offer_week: false, after: "11:00" })));
  assert.equal((await guestAction(context, "view") as { askDetails: boolean }).askDetails, false);
  assert.ok(!("error" in await guestAction(context, "pick", { start: f.request().offered[0]!.start })));
  assert.equal((await guestAction(context, "view") as { askDetails: boolean }).askDetails, false);
});

test("guests can re-offer and book dinner but cannot widen its meal window", async t => {
  const f = fixture(t);
  const request = f.ledger.requests[0]!;
  request.meal = "dinner";
  request.durationMin = 60;
  request.constraints = { days: ["mon", "tue"], from: "2026-10-05", to: "2026-10-06" };
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { offer_week: false, after: "17:00", before: "23:00" });
  assert.ok(!("error" in result), JSON.stringify(result));
  const offered = f.request().offered;
  assert.equal(offered.length, 3);
  assert.ok(offered.every(o => o.start.slice(11, 16) >= "18:00" && o.end.slice(11, 16) <= "21:00"));
  const booked = await guestAction(context, "pick", { start: offered[0]!.start });
  assert.ok(!("error" in booked), JSON.stringify(booked));
  assert.equal(f.request().status, "booked");
});


test("a duration change's replacement topic reaches holds, booking titles and the owner-facing group label", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.topic = "30-minute call";
  f.save(f.ledger);
  const { origin, handle, name, chatUid, constraints, allowOverlap, format, locale } = f.request();
  await calendarAction("request-one", { action: "offer", request: {
    origin, handle, name, chatUid, constraints, allowOverlap, format, locale, topic: "60-minute call", durationMin: 60,
    offered: [{ start: "2026-10-06T11:00:00Z", end: "2026-10-06T12:00:00Z", account: "owner@example.com" }],
  } });
  f.ledger.requests[0]!.durationMin = 60;
  const hold = f.commands.find(c => c[2] === "create")!;
  assert.equal(hold[hold.indexOf("--summary") + 1], "Hold: 60-minute call with Guest");
  const booked = await guestAction(context, "pick", { start: f.request().offered[0]!.start });
  assert.ok(!("error" in booked), JSON.stringify(booked));
  const booking = f.commands.find(c => c[2] === "update")!;
  assert.equal(booking[booking.indexOf("--summary") + 1], "60-minute call with Guest");
  assert.equal(f.request().durationMin, 60);
  await f.act(context, "ask_owner", { question: "Should I bring the budget numbers?" });
  assert.deepEqual(f.ownerLines, [`Guest asked in your 60-minute call thread. Guest question: "Should I bring the budget numbers?". Reply there, or tell me what to say.`]);
});

test("an owner duration change keeps an unanswered opener question suppressed on guest re-offers", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.detailsAskedAt = new Date(now).toISOString();
  f.ledger.requests[0]!.durationMin = 60;
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { offer_week: false, days: ["tue"] });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("askDetails" in result && result.askDetails, false);
  assert.equal(f.request().detailsAskedAt, new Date(now).toISOString());
  assert.equal(f.request().format, "unknown");
  assert.equal(f.request().durationMin, 60);
});


test("owner-group lunch uses the selected duration within the meal window", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  f.events.clear();
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { topic: "Lunch", meal: "lunch", durationMin: 60 });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().meal, "lunch");
  assert.ok(f.request().offered.every(o => o.start.slice(11, 16) >= "11:30" && o.end.slice(11, 16) <= "13:30"));
  assert.equal(f.request().durationMin, 60);
  assert.equal(f.request().offered[0]!.account, "owner@example.com");
});


test("guest next_week uses the source timestamp and owner timezone before filtering weekdays", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints!.to = "2026-10-16";
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { offer_week: false, next_week: "2026-10-05T23:30:00Z", days: ["tue"] });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.ok(f.request().offered.length > 0);
  assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-13")), JSON.stringify(f.request().offered));
});


for (const [display, contact, expected] of [
  ["Tia", undefined, "Tia"], ["", undefined, "Guest"], ["unnamed member", undefined, "Guest"],
  [context.requesterSenderId, undefined, "Guest"], [context.requesterSenderId, "missing", undefined],
  [context.requesterSenderId, "suffix-only", undefined], [context.requesterSenderId, "unavailable", undefined],
] as const) test(`owner-group resolves participant names: ${display || "blank"}, ${contact ?? "exact contact"}`, async t => {
  const f = fixture(t, contact === "suffix-only" ? "S|0\nR|1|Wrong|Person|\nP|1|+44551234567||" : contact ? "" : undefined);
  f.save({ requests: [] });
  f.events.clear();
  f.participants[2]!.display_name = display;
  if (contact === "unavailable") f.fail.add("-c");
  const args = { handle: "+15557654321", topic: "Lunch", durationMin: 30, offered: offers };
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, args);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().handle, context.requesterSenderId);
  assert.equal(f.request().name, expected);
  assert.equal(f.commands.some(argv => argv[0] === "/bin/sh"), display !== "Tia");
  const creates = f.commands.filter(argv => argv[2] === "create");
  assert.equal(creates.length, SLOT_COUNT);
  assert.ok(creates.every(argv => argv[argv.indexOf("--summary") + 1] === `Hold: Lunch with ${expected ?? context.requesterSenderId}`));
});

test("owner group offers refuse missing or ambiguous guest participants before calendar writes", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  const ctx = { ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" };
  f.events.clear();
  const args = { handle: context.requesterSenderId, name: "Alder", topic: "Lunch", durationMin: 30, offered: offers };
  f.participants.push({ ...f.participants[2]!, provider_key: "+15550108502" });
  assert.ok("error" in await offerOwnerGroup(ctx, args));
  f.participants.pop();
  f.participants[2]!.provider_key = "";
  assert.ok("error" in await offerOwnerGroup(ctx, args));
  assert.deepEqual(f.read().requests, []);
  assert.deepEqual(f.commands, []);
});


test("owner group participant lookup failure stops before creating holds", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE API ERROR", { status: 503 }));
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { topic: "Lunch", durationMin: 30 });
  assert.ok("error" in result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.deepEqual(f.read().requests, []);
  assert.deepEqual(f.commands, []);
});

test("a pending time approval suppresses detail questions without consuming the later question", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.pendingOwner = { start: "2026-10-05T20:00:00Z", end: "2026-10-05T20:30:00Z", askedAt: new Date(now).toISOString() };
  f.save(f.ledger);
  const result = await guestAction(context, "view");
  assert.equal("askDetails" in result && result.askDetails, false);
  assert.equal(f.request().detailsAskedAt, undefined);
});

test("owner-group records model duration and saves the owner's guest name for DM lookup", async t => {
  const f = fixture(t, "");
  f.save({ requests: [] });
  f.events.clear();
  f.participants[2]!.display_name = "unnamed member";
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const result = await tool.execute("offer", { introduction: "needed", topic: "call", name: "Bo", durationMin: 45 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.request().durationMin, 45);
  assert.equal(tool.parameters.properties.durationMin.type, "integer");
  assert.equal(f.request().name, "Bo");
  assert.ok(f.request().offered.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 45 * 60_000));
  const found = cli("ledger.ts", ["find", "--name", " bo "], { MEETLY_HOME: f.home });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.json.request.id, f.request().id);
  assert.equal(found.json.request.chatUid, "chat-one");
});


for (const start of [{ weekday: "thu" }, { weekday: "thu", time: "09:00" }] as const)
test(`a Thursday preference outside Monday-Wednesday returns a refusal with offer-week alternatives: ${JSON.stringify(start)}`, async t => {
  const f = fixture(t, undefined, "America/Los_Angeles");
  const request = f.ledger.requests[0]!;
  request.constraints = { days: ["mon", "tue", "wed"], from: "2026-10-12", to: "2026-10-14" };
  request.offered = [12, 13].map(day => ({ start: `2026-10-${day}T09:00:00-07:00`, end: `2026-10-${day}T09:30:00-07:00`, holdId: `offer-${day}`, account: "owner@example.com" }));
  f.save(f.ledger); f.events.clear();
  const result = await f.tools.get("meetly_other_times")!.execute("weekday", { offer_week: true, start });
  const details = JSON.parse(result.content[0]!.text);
  assert.equal(details.preferencesUnavailable, true, JSON.stringify(details));
  assert.ok(details.offered.length);
  assert.ok(details.offered.every((o: { start: string }) => o.start >= "2026-10-12" && o.start < "2026-10-15"));
  assert.equal(f.ownerLines.length, 0);
  t.diagnostic(JSON.stringify(details));
});

test("a bare Thursday preference resolves to the offer week without inventing a clock time", async t => {
  const f = fixture(t);
  const request = f.ledger.requests[0]!;
  request.constraints = {};
  request.offered = [{ start: "2026-10-12T10:00:00Z", end: "2026-10-12T10:30:00Z", holdId: "offer", account: "owner@example.com" }];
  f.save(f.ledger); f.events.clear();
  const result = await f.tools.get("meetly_other_times")!.execute("weekday", { offer_week: true, start: { weekday: "thu" } });
  const details = JSON.parse(result.content[0]!.text);
  assert.equal(details.preferencesUnavailable, false, JSON.stringify(details));
  assert.ok(details.offered.length);
  assert.ok(details.offered.every((o: { start: string }) => o.start.startsWith("2026-10-15")));
  assert.equal(f.ownerLines.length, 0);
});

for (const [meal, duration] of [["lunch", 60], ["dinner", 60], ["coffee", 30]] as const)
test(`owner-group preserves explicit ${meal} duration`, async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const result = await tool.execute("offer", { introduction: "needed", topic: meal, meal, durationMin: duration });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.request().durationMin, duration);
  assert.ok(f.request().offered.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === duration * 60_000));
});

test("DM offers save the owner's guest name and keep it through a replacement", async t => {
  const f = fixture(t, "");
  f.save({ requests: [] }); f.events.clear();
  const { request } = await offerRequest({ origin: "owner", handle: context.requesterSenderId, name: "Dee", topic: "coffee", meal: "coffee",
    offered: offers.map(({ start, end }) => ({ start, end })) });
  assert.equal(f.request().name, "Dee");
  const next = await offerRequest({ origin: "owner", handle: request.handle, topic: "coffee", meal: "coffee",
    offered: [{ start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z" }] });
  assert.equal(next.request.name, "Dee");
  assert.equal(next.request.id, request.id);
  assert.ok(f.commands.filter(c => c[2] === "create").every(c => c[c.indexOf("--summary") + 1] === "Hold: coffee with Dee"));
});

test("owner-group busy requested times rank nearby alternatives while retaining hard bounds", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  f.events.set("busy", event("busy", "2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z"));
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, {
    topic: "call", durationMin: 30, constraints: { days: ["tue"], from: "2026-10-06", to: "2026-10-13", after: "11:00", before: "15:00" },
    proposed: { from: "2026-10-13", to: "2026-10-13", after: "12:00", before: "12:30" },
  });
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true, JSON.stringify(result));
  assert.deepEqual(f.request().offered.map(o => o.start), ["2026-10-13T11:30:00+00:00", "2026-10-13T11:00:00+00:00", "2026-10-13T13:00:00+00:00"]);
});
for (const constraints of [
  { days: ["mon", "tue", "wed"] },
  { from: "2026-10-12" },
  { to: "2026-10-07" },
  { days: [] },
  { after: "20:15" },
  { before: "20:15" },
]) test(`out-of-hours approval cannot bypass owner conditions: ${JSON.stringify(constraints)}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = constraints;
  f.save(f.ledger);
  const before = f.read();
  const result = await f.act(context, "other_times", { offer_week: false, start: "2026-10-08T20:00:00Z" });
  if ("after" in constraints || "before" in constraints) {
    assert.match(JSON.stringify(result), /time.*outside.*owner.*conditions/i);
    assert.deepEqual(f.read(), before);
  } else if (constraints.days?.length === 0) {
    assert.match(JSON.stringify(result), /No other times are available/);
    assert.deepEqual(f.request().offered, before.requests[0]!.offered);
    assert.deepEqual(f.request().constraints, before.requests[0]!.constraints);
    assert.ok(f.request().pendingOwner && "question" in f.request().pendingOwner!);
    assert.ok(f.commands.every(c => c[2] === "events"));
  } else {
    assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true, JSON.stringify(result));
    assert.ok(f.request().offered.length);
    assert.ok(f.request().offered.every(o => withinConstraints(Date.parse(o.start), Date.parse(o.end), "UTC", constraints)));
    assert.ok(f.request().offered.every(o => o.start.slice(0, 10) !== "2026-10-08"));
  }
  if (constraints.days?.length === 0) assert.equal(f.ownerLines.length, 1);
  else {
    assert.equal(f.request().pendingOwner, undefined);
    assert.equal(f.ownerLines.length, 0);
  }
  assert.equal(f.deliveries.length, 0);
});

test("owner-group duration steering atomically replaces holds in the same chat", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  const ctx = { ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" };
  assert.ok(!("error" in await offerOwnerGroup(ctx, { topic: "30-minute call", durationMin: 30 })));
  const before = f.request();
  await calendarAction(before.id, { action: "duration", durationMin: 60, topic: "60-minute call",
    offered: before.offered.map(({ start }) => ({ start, end: new Date(Date.parse(start) + 60 * 60_000).toISOString() })) });
  assert.equal(f.request().id, before.id);
  assert.equal(f.request().origin, "owner-group");
  assert.equal(f.request().chatUid, before.chatUid);
  assert.equal(f.request().durationMin, 60);
  assert.equal(f.request().offered.length, SLOT_COUNT);
  assert.ok(f.request().offered.every(o => Date.parse(o.end) - Date.parse(o.start) === 60 * 60_000));
  assert.ok(before.offered.every(o => f.events.get(o.holdId!)?.status === "cancelled"));
});

for (const change of [
  { senderIsOwner: false }, { senderIsOwner: undefined }, { requesterSenderId: undefined },
  { messageChannel: "email" }, { agentAccountId: "email" },
  { sessionKey: "agent:main:plow:group:chat-one" }, { sessionKey: undefined },
]) test(`overlap offer rejects non-owner-DM runtime context ${JSON.stringify(change)}`, async t => {
  const f = fixture(t), before = f.read();
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context,
    senderIsOwner: true, sessionKey: "agent:main:main", ...change }); } }, offerRequest);
  const result = await tool.execute("offer", { ...f.ledger.requests[0], allowOverlapTitles: ["Weekly Claw"],
    senderIsOwner: true, sessionKey: "agent:main:main" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /owner.*main Plow DM/);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.commands, []);
});

for (const failure of ["interval", "argument"]) test(`owner DM duration rejects ${failure} without writes`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.durationMin = 45;
  f.save(f.ledger);
  const before = f.read();
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("offer", { origin: "owner", handle: context.requesterSenderId, topic: "Call",
    offered: offers.map(({ start }) => ({ start, end: new Date(Date.parse(start) + (failure === "interval" ? 30 : 45) * 60_000).toISOString() })),
    ...(failure === "argument" ? { durationMin: 45 } : {}),
  });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /[Ss]et.*duration/);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.commands, []);
});

test("owner-group requires the model to choose a duration before creating a request", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const result = await tool.execute("offer", { introduction: "needed", topic: "Call" });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /[Ss]et durationMin/);
  assert.deepEqual(f.read(), { requests: [] });
  assert.deepEqual(f.commands, []);
});

for (const replacement of [undefined, { days: ["wed"], from: "2026-10-07", to: "2026-10-07", after: "12:00", before: "16:00" }, {}]) {
  test(`owner-group re-offer replaces supplied policy and inherits omitted location: ${JSON.stringify(replacement)}`, async t => {
    const f = fixture(t);
    const saved = f.ledger.requests[0]!;
    saved.format = "in_person";
    saved.location = "Library";
    f.save(f.ledger);
    const oldHolds = saved.offered.map(o => o.holdId!);
    const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, {
      topic: "Planning", durationMin: saved.durationMin, ...(replacement === undefined ? {} : { constraints: replacement }),
    });
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.equal(f.request().id, saved.id);
    assert.equal(f.request().chatUid, saved.chatUid);
    assert.equal(f.request().location, "Library");
    assert.equal(f.request().format, "in_person");
    assert.deepEqual(f.request().constraints ?? {}, replacement ?? saved.constraints);
    assert.ok(f.request().offered.length > 0);
    if (replacement?.days) assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-07T") && o.start.slice(11, 16) >= "12:00" && o.end.slice(11, 16) <= "16:00"));
    assert.ok(oldHolds.every(id => f.events.get(id)?.status === "cancelled"));
    saved.constraints = f.request().constraints;
  });
}

for (const preference of [{ days: ["mon"] }, { start: "2026-10-12T10:00:00Z" }])
for (const offer_week of [false, true]) test(`explicit offer_week=${offer_week} controls search ${JSON.stringify(preference)}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { from: "2026-10-05", to: "2026-10-16" };
  f.save(f.ledger);
  f.events.set("busy", event("busy", "2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z"));
  const result = await f.act(context, "other_times", { offer_week, ...preference });
  if (offer_week) {
    assert.equal("code" in result && result.code, "NO_ALTERNATIVES");
    assert.deepEqual(f.request().offered, f.ledger.requests[0]!.offered);
    assert.deepEqual(f.request().constraints, f.ledger.requests[0]!.constraints);
    assert.ok(f.request().pendingOwner && "question" in f.request().pendingOwner!);
    assert.equal(f.ownerLines.length, 1);
    assert.ok(f.commands.every(c => c[2] === "events"));
  } else {
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-12")));
  }
});

for (const caller of ["guest", "owner"] as const) test(`${caller} preserves safe slots before truncated calendar coverage`, async t => {
  const f = fixture(t), fetch = globalThis.fetch;
  const cutoff = "2026-10-05T11:00:00Z";
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetch(url, init);
    if (String(url).startsWith("https://api.plow.test/")) return response;
    const argv: string[] = JSON.parse(String(init?.body)).params.arguments.argv;
    if (argv[2] !== "events" || Date.parse(argv[argv.indexOf("--to") + 1]!) <= Date.parse(cutoff)) return response;
    const envelope = await response.json();
    const content = envelope.result.content[0];
    const command = JSON.parse(content.text);
    command.output = JSON.stringify({ ...JSON.parse(command.output), truncated: { after: cutoff } });
    content.text = JSON.stringify(command);
    return Response.json(envelope);
  });
  const result = caller === "guest"
    ? await f.act(context, "other_times", { offer_week: false })
    : await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, { topic: "Call", durationMin: 30 });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.ok(f.request().offered.length > 0);
  assert.ok(f.request().offered.every(o => Date.parse(o.end) <= Date.parse(cutoff)));
  assert.ok(f.commands.some(c => c[2] === "create"));
});

test("guest alternatives search the owner's saved distant date", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { from: "2026-10-29", to: "2026-10-29" };
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { offer_week: false });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-29")));
});

for (const field of ["constraints", "proposed"] as const) test(`owner-group reads and holds explicit distant ${field}`, async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, {
    topic: "Planning", durationMin: 30, format: "meet",
    [field]: { from: "2026-10-29", to: "2026-10-29" },
  });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.ok(f.read().requests[0]!.offered.every(o => o.start.startsWith("2026-10-29")));
  assert.equal((result as any).preferencesUnavailable, false);
  const read = f.commands.find(a => a[2] === "events")!;
  assert.ok(read.some(a => a.includes("2026-10-30")), JSON.stringify(read));
});

test("owner-group resolves and persists next week from Sunday in the owner's zone", async t => {
  const f = fixture(t, undefined, "America/Los_Angeles");
  f.save({ requests: [] }); f.events.clear();
  t.mock.method(Date, "now", () => Date.parse("2026-10-05T02:12:33Z"));
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, {
    topic: "Planning", durationMin: 30, format: "meet",
    week: "next", constraints: { days: ["mon", "tue", "wed"] },
  });
  assert.ok(!("error" in result), JSON.stringify(result));
  const request = f.read().requests[0]!;
  assert.deepEqual(request.constraints, { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-11" });
  assert.deepEqual(request.offered.map(o => o.start.slice(0, 10)), ["2026-10-05", "2026-10-06", "2026-10-07"]);
});


test("guests can book an owner-selected start that crosses midnight", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  const offered = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { topic: "Late call", durationMin: 60, constraints: { days: ["mon"], startTime: "23:30" } });
  assert.ok(!("error" in offered), JSON.stringify(offered));
  const slot = f.request().offered[0]!;
  assert.equal(slot.start, "2026-10-05T23:30:00+00:00");
  assert.equal(slot.end, "2026-10-06T00:30:00+00:00");
  const result = await f.tools.get("meetly_pick_time")!.execute("pick", { start: slot.start });
  assert.equal(JSON.parse(result.content[0]!.text).status, "booked", result.content[0]!.text);
  assert.equal(f.request().status, "booked");
  assert.equal(f.request().booked!.end, slot.end);
});

test("guest exclusions persist until explicitly restored", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { from: "2026-10-05", to: "2026-10-09" };
  f.save(f.ledger);
  for (const args of [{ excludedDays: ["tue"] }, {}]) {
    const result = await f.act(context, "other_times", { ...args, offer_week: false });
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(f.request().excludedDays, ["tue"]);
    assert.ok(f.request().offered.every(o => !o.start.startsWith("2026-10-06")));
  }
  const restored = await f.act(context, "other_times", { offer_week: false, restoredDays: ["tue"], days: ["tue"] });
  assert.ok(!("error" in restored), JSON.stringify(restored));
  assert.deepEqual(f.request().excludedDays, []);
  assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-06")));
});

test("guest search requires an explicit date scope before creating holds", async t => {
  const f = fixture(t);
  const result = await guestAction(context, "other_times", {});
  assert.equal("code" in result && result.code, "DATE_SCOPE_REQUIRED");
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.commands, []);
});

for (const constraints of [undefined, {}, { days: ["wed"], after: "14:00" }]) {
  test(`owner next week replaces dates while respecting supplied policy: ${JSON.stringify(constraints)}`, async t => {
    const f = fixture(t);
    const saved = { days: ["tue", "thu"], after: "13:00", before: "15:00", startTime: "13:15", from: "2026-10-12", to: "2026-10-18" };
    f.ledger.requests[0]!.constraints = saved;
    f.save(f.ledger);
    const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
      { topic: "Call", durationMin: 30, week: "next", ...(constraints === undefined ? {} : { constraints }) });
    assert.ok(!("error" in result), JSON.stringify(result));
    const { from, to, ...policy } = saved;
    const expected = { ...(constraints ?? policy), from: "2026-10-05", to: "2026-10-11" };
    assert.deepEqual(f.request().constraints, expected);
    if (constraints === undefined) assert.ok(f.request().offered.every(o =>
      ["2026-10-06", "2026-10-08"].includes(o.start.slice(0, 10)) && o.start.slice(11, 16) === "13:15"));
    f.ledger.requests[0]!.constraints = expected;
  });
}

for (const to of ["2026-11-30", "2026-12-01"]) test(`guest calendar-day cap across fall-back DST through ${to}`, async t => {
  const f = fixture(t, undefined, "America/Los_Angeles");
  f.ledger.requests[0]!.constraints = { from: "2026-10-02", to };
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { offer_week: false });
  if (to === "2026-11-30") {
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.ok(f.request().offered.length > 0);
    assert.ok(f.commands.some(c => c[2] === "events"));
  } else {
    assert.equal("code" in result && result.code, "SEARCH_RANGE_TOO_LARGE");
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.read(), f.ledger);
  }
});

test("oversized guest coverage is rejected before calendar reads or hold changes", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = {};
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", {
    offer_week: false, from: "2026-10-05", to: "2027-12-31", excludedDays: ["tue"],
  });
  assert.match(JSON.stringify(result), /60 days/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.request().offered, f.ledger.requests[0]!.offered);
  assert.deepEqual(f.request().excludedDays, ["tue"]);
});

test("a detail-question reservation during search does not invalidate the scheduling snapshot", async t => {
  const f = fixture(t);
  f.hooks.before = async () => {
    f.hooks.before = undefined;
    await guestAction(context, "view");
  };
  const result = await f.act(context, "other_times", { offer_week: false, after: "11:00" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("askDetails" in result && result.askDetails, false);
});

test("guest calendar failures return a safe terminal recovery through the plugin", async t => {
  const f = fixture(t);
  f.fail.add("events");
  const result = await f.tools.get("meetly_other_times")!.execute("call", { offer_week: false });
  const detail = JSON.parse(result.content[0]!.text);
  assert.equal(detail.code, "CALENDAR_UNAVAILABLE");
  assert.deepEqual(detail.recovery, { action: "reply", message: "I couldn't update the meeting times. Please try again later." });
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|owner@example.com/);
});

for (const existing of [false, true]) test(`malformed owner locale is rejected before calendar writes: existing=${existing}`, async t => {
  const f = fixture(t);
  if (!existing) { f.save({ requests: [] }); f.events.clear(); }
  const before = f.read();
  await assert.rejects(offerRequest({ origin: "owner", handle: context.requesterSenderId,
    topic: "Call", durationMin: 30, locale: "en_US",
    offered: offers.map(({ start, end }) => ({ start, end })),
  }), /language tag/i);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.read(), before);
});

test("excluded weekdays block stale picks when replacement search has no slots", async t => {
  const f = fixture(t);
  const result = await f.act(context, "other_times", { offer_week: false, excludedDays: ["mon", "tue"] });
  assert.ok("error" in result);
  const before = f.commands.length;
  const picked = await guestAction(context, "pick", { start: offers[0]!.start });
  assert.ok("error" in picked, JSON.stringify(picked));
  assert.equal(f.request().status, "offered");
  assert.ok(f.commands.slice(before).every(c => c[2] === "events"));
});

test("owner-group re-offers respect saved excluded weekdays", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.excludedDays = ["mon"];
  f.save(f.ledger);
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { topic: "Call", durationMin: 30 });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.ok(f.request().offered.every(o => o.start.startsWith("2026-10-06")), JSON.stringify(f.request().offered));
});

test("owner DM rejects four offered times before calendar or ledger effects", async t => {
  const f = fixture(t), before = f.read();
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("call", { origin: "owner", handle: context.requesterSenderId, topic: "Call",
    allowOverlapTitles: ["Approved overlap"],
    offered: Array.from({ length: 4 }, (_, i) => ({ start: `2026-10-0${5 + i}T10:00:00Z`, end: `2026-10-0${5 + i}T10:30:00Z` })) });
  assert.equal(result.isError, true);
  assert.match(result.details.error, /at most 3/i);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.read(), before);
  assert.equal(tool.parameters.properties.offered.maxItems, 3);
});

test("owner DM meal schema carries a new lunch through the calendar writer", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  assert.deepEqual(tool.parameters.properties.meal?.enum, ["lunch", "dinner", "coffee"]);
  const result = await tool.execute("call", { origin: "owner", handle: context.requesterSenderId, topic: "Lunch", meal: "lunch",
    offered: [{ start: "2026-10-05T12:00:00Z", end: "2026-10-05T13:00:00Z" }] });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(f.request().durationMin, 60);
  assert.equal(f.request().meal, "lunch");
});

test("exact clock constraints are owner-only; guests use the dated start argument", () => {
  const tools = new Map<string, any>();
  const api = { registerTool(factory: any) { const tool = factory(context); tools.set(tool.name, tool); } };
  registerGuestTools(api); registerOwnerGroupTool(api);
  assert.equal(tools.get("meetly_other_times").parameters.properties.startTime, undefined);
  assert.equal(tools.get("meetly_offer_owner_group").parameters.properties.constraints.properties.startTime.type, "string");
});

for (const { deliveryFails, ownerAskSent, message, sends } of [
  { deliveryFails: false, ownerAskSent: true, message: "Those times don't work. I've asked Alex about another day or time and will get back to you here.", sends: 1 },
  { deliveryFails: true, ownerAskSent: undefined, message: "Those times don't work. I can't confirm another time yet.", sends: 1 },
]) test(`exhausted scheduling keeps private conditions out of its reply: deliveryFails=${deliveryFails}`, async t => {
  const f = fixture(t);
  f.events.set("busy", event("busy", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"));
  f.delivery.fail = deliveryFails;
  const tool = f.tools.get("meetly_other_times")!;
  const result = JSON.parse((await tool.execute("first", { offer_week: false })).content[0]!.text);
  assert.equal(result.code, "NO_ALTERNATIVES");
  assert.equal(result.conditions, undefined);
  const pending = f.request().pendingOwner;
  assert.ok(pending && "question" in pending && pending.alternatives);
  assert.deepEqual(pending.alternatives.previousStarts, f.request().offered.map(o => o.start));
  assert.notEqual(result.silent, true);
  assert.equal(result.ownerAskSent, ownerAskSent);
  assert.equal(result.message, message);
  assert.equal(result.recovery.action, "wait");
  assert.equal(f.deliveries.length, sends);
  await tool.execute("again", { offer_week: false });
  assert.equal(f.deliveries.length, sends);
});

for (const invited of [false, true]) test(`booked guest changes notify the owner privately and report invitation evidence: invited=${invited}`, async t => {
  const f = fixture(t, invited ? undefined : "S|0\n");
  const call = async (name: string, args = {}) => JSON.parse((await f.tools.get(name)!.execute("call", args)).content[0]!.text);
  const initial = await call("meetly_pick_time", { start: offers[0]!.start });
  assert.equal(initial.invitationSent, invited);
  assert.equal(f.deliveries.length, 0);
  await call("meetly_other_times", { offer_week: false, start: offers[1]!.start });
  const moved = await call("meetly_pick_time", { start: offers[1]!.start });
  assert.equal(moved.invitationUpdated, invited);
  assert.equal(moved.ownerNotified, true);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0]!.to, "plow-owner");
  assert.match(f.ownerLines[0]!, /Lunch with Guest moved to.*10\/6.*UTC/);
  const cancelled = await call("meetly_decline");
  assert.equal(cancelled.ownerNotified, true);
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[1]!.to, "plow-owner");
  assert.match(f.ownerLines[1]!, /^Guest cancelled Lunch on .*UTC/);
  await call("meetly_decline");
  assert.equal(f.deliveries.length, 2, "repeated declines must not send another DM");
  t.diagnostic(JSON.stringify({ moved, cancelled, ownerDMs: f.ownerLines }));
});

test("a failed owner notice preserves a completed move and never claims delivery", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  await f.act(context, "other_times", { offer_week: false, start: offers[1]!.start });
  f.delivery.fail = true;
  const result = JSON.parse((await f.tools.get("meetly_pick_time")!.execute("call", { start: offers[1]!.start })).content[0]!.text);
  assert.equal(result.ownerNotified, false);
  assert.equal(result.warning, "owner-notification-unconfirmed");
  assert.equal(result.error, undefined);
  assert.equal(Date.parse(f.request().booked!.start), Date.parse(offers[1]!.start));
  assert.equal(f.deliveries.length, 1);
});

test("an incomplete guest cancellation names the guest and keeps cleanup pending", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  f.fail.add("delete");
  const result = await f.act(context, "decline");
  assert.ok("cleanupPending" in result && result.cleanupPending);
  assert.match(f.ownerLines[0]!, /^Guest requested cancellation of Lunch on .*calendar cleanup is pending/);
  t.diagnostic(`Owner DM: ${f.ownerLines[0]}`);
});

test("guest reschedules and cancels this thread's booked lunch through the calendar writer", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.meal = "lunch";
  f.ledger.requests[0]!.offered = [{ ...offers[0]!, start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:30:00Z" }];
  f.events.set("hold-one", event("hold-one", "2026-10-05T12:00:00Z", "2026-10-05T12:30:00Z"));
  f.save(f.ledger);
  await f.act(context, "pick", { start: "2026-10-05T12:00:00Z" });
  const booked = f.request().booked;
  const offered = await f.act(context, "other_times", { offer_week: false, start: "2026-10-06T12:00" });
  assert.ok(!("error" in offered), JSON.stringify(offered));
  assert.equal("offered" in offered && (offered.offered as unknown[]).length, 1);
  assert.deepEqual(f.request().booked, booked);
  assert.equal(f.request().status, "booked");
  const moved = await f.act(context, "pick", { start: "2026-10-06T12:00:00Z" });
  assert.ok(!("error" in moved), JSON.stringify(moved));
  assert.equal(f.request().eventId, "hold-one");
  assert.equal(Date.parse(f.request().booked!.start), Date.parse("2026-10-06T12:00:00Z"));
  const move = f.commands.filter(c => c[2] === "update").at(-1)!;
  assert.equal(move[4], "hold-one");
  assert.equal(move[move.indexOf("--send-updates") + 1], "all");
  assert.ok(!move.includes("--attendees"), "preserve existing invitees on a move");
  assert.equal(f.events.get("new-1")!.status, "cancelled");
  const cancelled = await f.act(context, "decline");
  assert.equal("status" in cancelled && cancelled.status, "dropped");
  assert.equal(f.events.get("hold-one")!.status, "cancelled");
  const deletion = f.commands.find(c => c[2] === "delete" && c[4] === "hold-one")!;
  assert.equal(deletion[deletion.indexOf("--send-updates") + 1], "all");
  assert.equal(f.read().requests.length, 1);
});

test("booked guest picks require this thread's current replacement and preserve owner conditions", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  const booked = f.request().booked;
  assert.ok("error" in await f.act(context, "pick", { start: offers[1]!.start }));
  const alternatives = await f.act(context, "other_times", { offer_week: false, days: ["thu"], after: "16:00" });
  assert.ok("preferencesUnavailable" in alternatives && alternatives.preferencesUnavailable);
  assert.match("message" in alternatives ? String(alternatives.message) : "", /Replacement times are held:/);
  t.diagnostic(`Replacement reply: ${"message" in alternatives && alternatives.message}`);
  const replacement = f.request().offered;
  assert.ok(replacement);
  assert.ok(replacement.every(o => ["2026-10-05", "2026-10-06"].includes(o.start.slice(0, 10)) && o.start.slice(11, 16) < "15:00"));
  const rejected = await f.tools.get("meetly_other_times")!.execute("call", { offer_week: false, excludedDays: ["mon", "tue"] });
  const rejectedDetails = JSON.parse(rejected.content[0]!.text);
  assert.ok(rejectedDetails.error);
  assert.equal(rejectedDetails.offered, undefined, "do not present old holds that the guest just ruled out");
  assert.deepEqual(f.request().offered, replacement);
  for (const ctx of [{ ...context, nativeChannelId: "another-chat" }, { ...context, requesterSenderId: "+15559999999" }]) {
    assert.ok("error" in await f.act(ctx, "pick", { start: replacement[0]!.start }));
    assert.ok("error" in await f.act(ctx, "decline"));
  }
  await calendarAction("request-one", { action: "expire" }, { now: () => now + 49 * 3600_000 });
  assert.deepEqual(f.request().offered, []);
  assert.ok("error" in await f.act(context, "pick", { start: replacement[0]!.start }));
  assert.deepEqual(f.request().booked, booked);
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
});

for (const turnStartedAt of [undefined, now - 1, now]) test(`a booked guest cannot pick a replacement created in this turn (${turnStartedAt})`, async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  await f.act(context, "other_times", { offer_week: false, start: offers[1]!.start });
  const before = f.read();
  const commands = f.commands.length;
  const result = await guestAction({ ...context, turnStartedAt } as GuestContext, "pick", {
    start: offers[1]!.start, turnStartedAt: now + 1,
  } as GuestArgs);
  assert.ok("error" in result, JSON.stringify(result));
  assert.deepEqual(f.read(), before);
  assert.equal(f.commands.length, commands, "reject before any calendar operation");
  assert.equal(f.ownerLines.length, 0);
});

test("runtime hooks keep a replacement unpickable through a prompt rebuild, then allow the next guest turn", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  const hooks: Record<string, (event: any, ctx: any) => any> = {};
  plugin.register({ registerTool() {}, on(name: string, fn: typeof hooks[string]) { hooks[name] = fn; }, logger: { info() {} } });
  const ctx = { ...context, sessionKey: "agent:main:plow:group:chat-one" };
  const turn = { channel: "plow", accountId: "chat", sessionKey: ctx.sessionKey, runId: "replacement-turn" };
  const tools = new Map<string, { execute: (id: string, args: object) => Promise<any> }>();
  const register = () => registerGuestTools({ registerTool(factory: (ctx: object) => any) {
    const tool = factory(ctx); tools.set(tool.name, tool);
  } }, (bound, action, args) => guestAction(bound, action, args, async text => { f.ownerLines.push(text); }));
  register();
  t.mock.method(Date, "now", () => now - 1);
  await hooks.before_prompt_build!({}, turn);
  t.mock.method(Date, "now", () => now);
  const offered = await tools.get("meetly_other_times")!.execute("offer", { offer_week: false, start: offers[1]!.start });
  assert.equal(offered.isError, false);
  assert.equal(Date.parse(offered.details.offered[0].start), Date.parse(offers[1]!.start));
  const before = f.read();
  const commands = f.commands.length;
  const pick = async (id: string) => {
    hooks.before_tool_call!({ toolName: "meetly_pick_time" }, { ...turn, toolCallId: id });
    return tools.get("meetly_pick_time")!.execute(id, { start: offers[1]!.start, turnStartedAt: now + 1000 });
  };
  assert.equal((await pick("same-run")).isError, true);
  t.mock.method(Date, "now", () => now + 1);
  await hooks.before_prompt_build!({}, turn);
  register();
  assert.equal((await pick("rebuilt-prompt")).isError, true);
  assert.deepEqual(f.read(), before);
  assert.equal(f.commands.length, commands);
  assert.equal(f.ownerLines.length, 0);
  hooks.agent_end!({}, turn);
  turn.runId = "guest-choice-turn";
  await hooks.before_prompt_build!({}, turn);
  const moved = await pick("later-choice");
  assert.equal(moved.isError, false, JSON.stringify(moved));
  assert.equal(Date.parse(f.request().booked!.start), Date.parse(offers[1]!.start));
  assert.equal(f.ownerLines.length, 1);
  hooks.agent_end!({}, turn);
  t.diagnostic(`Same-run pick blocked; booking stayed at ${before.requests[0]!.booked!.start}. Next-turn choice moved it to ${f.request().booked!.start}.`);
});

test("booking in person carries the no-more-details instruction after the opener question", async t => {
  const f = fixture(t);
  const first = await f.tools.get("meetly_view_request")!.execute("view", {});
  assert.equal(JSON.parse(first.content[0]!.text).askDetails, true);
  assert.doesNotMatch(first.content.slice(1).map(c => c.text).join("\n"), /do not ask how or where/i);
  await f.tools.get("meetly_set_format")!.execute("format", { format: "in_person" });
  const booked = await f.tools.get("meetly_pick_time")!.execute("pick", { start: offers[0]!.start });
  const details = JSON.parse(booked.content[0]!.text);
  assert.equal(details.askDetails, false);
  assert.equal(details.status, "booked");
  assert.equal(details.format, "in_person");
  assert.ok(!details.location);
  assert.match(booked.content.slice(1).map(c => c.text).join("\n"), /do not ask how or where to meet.*missing/i);
});


for (const fail of [false, true]) test(`an unbooked decline notifies the owner once: failure=${fail}`, async t => {
  const f = fixture(t);
  let sends = 0;
  const send = async (text: string) => {
    sends++;
    assert.equal(f.request().status, "dropped");
    assert.match(text, /Guest declined.*Lunch/);
    if (fail) throw new Error("delivery unavailable");
  };
  const result = await guestAction(context, "decline", {}, send) as { ownerNotified: boolean };
  assert.equal(result.ownerNotified, !fail);
  assert.equal(sends, 1);
  await guestAction(context, "decline", {}, send);
  assert.equal(sends, 1);
});


test("owner DM overlap replacement stays on the selected booked request", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  const original = f.request();
  const slot = { start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:30:00Z" };
  f.events.set("private-overlap", { ...event("private-overlap", slot.start, slot.end), summary: "Weekly Claw" });
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("replace", { requestId: original.id, origin: original.origin,
    handle: original.handle, topic: original.topic,
    allowOverlapTitles: ["Weekly Claw"], offered: [slot] });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.read().requests.length, 1);
  assert.deepEqual(f.request().booked, original.booked);
  assert.equal(tool.parameters.properties.requestId.type, "string");
  const picked = await f.act(context, "pick", { start: slot.start });
  assert.ok(!("error" in picked), JSON.stringify(picked));
  assert.equal(f.request().eventId, original.eventId);
  assert.equal(Date.parse(f.request().booked!.start), Date.parse(slot.start));
  assert.deepEqual(f.request().allowOverlap, []);
  assert.ok(!f.commands.filter(c => c[2] === "update").at(-1)!.includes("--attendees"));
  t.diagnostic(JSON.stringify({ requests: f.read().requests.length, eventId: f.request().eventId, booked: f.request().booked }));
});

for (const selected of [
  { requestId: "missing" }, { requestId: "request-one", handle: "+15550009999" },
  { requestId: "request-one", chatUid: "another-chat" },
]) test(`owner DM rejects a mismatched selected request: ${JSON.stringify(selected)}`, async t => {
  const f = fixture(t), before = f.read();
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("replace", { origin: "owner", handle: context.requesterSenderId, topic: "Lunch",
    offered: [{ start: offers[0]!.start, end: offers[0]!.end }], ...selected });
  assert.equal(result.isError, true);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.commands, []);
});
for (const args of [{ question: "Should I bring the budget?" }, { start: "2026-10-05T20:00" }]) {
  test(`owner ask reserves its monitor fingerprint before sending: ${JSON.stringify(args)}`, async t => {
    const f = fixture(t);
    f.ledger.requests[0]!.constraints!.before = "21:00";
    f.save(f.ledger);
    let sends = 0;
    let duringSend: string | null = null;
    const result = await guestAction(context, "question" in args ? "ask_owner" : "other_times", { offer_week: false, ...args }, async () => {
      sends++;
      duringSend = reserveNudges(f.read(), now).text;
    });
    assert.equal("ownerAskSent" in result && result.ownerAskSent, true);
    assert.equal(sends, 1);
    assert.equal(duringSend, null, "a concurrent poll must not duplicate this DM");
    assert.equal(reserveNudges(f.read(), now + 5 * 60_000).text, null);
    assert.ok(f.request().lastNudge);
  });
}

for (const existing of [true, false]) for (const delivery of ["sent", "unknown", "throws"]) {
  test(`owner-group contact confirmation stays private (${existing ? "existing request" : "preference only"}, ${delivery})`, async t => {
    const f = fixture(t);
    f.ledger.blockedHandles = [context.requesterSenderId];
    if (!existing) {
      f.ledger.requests[0]!.status = "dropped";
      delete f.ledger.requests[0]!.chatUid;
      f.ledger.requests[0]!.offered = [];
    }
    f.save(f.ledger);
    const before = f.read();
    const sent: any[] = [];
    let tool: any;
    const ctx = { ...context, senderIsOwner: true, requesterSenderId: "plow-owner", sessionKey: "agent:main:plow:group:chat-one" };
    const hooks: Record<string, (...args: any[]) => any> = {};
    plugin.register({ registerTool() {}, on(name: string, fn: any) { hooks[name] = fn; }, logger: { info() {} } });
    const turn = { runId: t.name, sessionKey: ctx.sessionKey };
    await hooks.before_prompt_build!({}, turn);
    t.after(() => hooks.agent_end!({}, turn));
    registerOwnerGroupTool({
      registerTool(factory: any) { tool = factory(ctx); },
      runtime: { channel: {
        routing: { resolveAgentRoute(args: any) {
          assert.deepEqual(args.peer, { kind: "direct", id: "plow-owner" });
          return { agentId: "main", sessionKey: "agent:main:main" };
        } },
        session: { resolveStorePath: () => "/sessions", updateLastRoute: async () => {} },
      } },
    }, offerOwnerGroup, async () => ({
      buildOutboundSessionContext: (args: any) => args,
      sendDurableMessageBatch: async (args: any) => {
        sent.push(args);
        assert.equal(reserveNudges(f.read(), now).text, null, "private contact handoff must reserve the poll fingerprint before sending");
        if (delivery === "throws") throw new Error("PRIVATE transport diagnostic");
        return { status: delivery };
      },
    }));
    const ask = async (id: string, name?: string) => {
      hooks.before_tool_call!({ toolName: "meetly_offer_owner_group" }, { ...turn, toolCallId: id });
      return tool.execute(id, { introduction: "already_introduced", topic: "Coffee", durationMin: 30, name, proposed: { from: "2026-10-05", to: "2026-10-11" } });
    };
    const [result] = await Promise.all([ask("offer"), ask("parallel-first")]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "plow-owner");
    assert.equal(sent[0].session.sessionKey, "agent:main:main");
    assert.match(sent[0].payloads[0].text, /Name: "Guest".*\+15551234567/);
    assert.match(sent[0].payloads[0].text, /Coffee/);
    assert.match(sent[0].payloads[0].text, /2026-10-05.*2026-10-11/);
    assert.match(sent[0].payloads[0].text, /do not contact/i);
    assert.match(sent[0].payloads[0].text, /confirm.*here/i);
    assert.equal(result.details.silent, true);
    assert.equal(result.details.ownerAskSent, delivery === "sent");
    assert.equal(result.details.recovery.action, "silent");
    assert.equal(result.details.recovery.retry, false);
    assert.doesNotMatch(JSON.stringify(result), /do.?not.?contact|marked|blocked|PRIVATE|Guest|Coffee|15551234567/i);
    const saved = f.read().requests.find(r => r.pendingOwner && "contact" in r.pendingOwner)!;
    assert.ok(saved.pendingOwner && "contact" in saved.pendingOwner);
    const contact = saved.pendingOwner.contact;
    assert.ok(pendingOwnerList(f.read()).some(r => r.id === saved.id));
    assert.equal(pipeline(f.read(), now).find(r => r.id === saved.id)?.reason, "owner-decision");
    assert.equal(saved.chatUid, "chat-one");
    assert.equal(contact.topic, "Coffee");
    assert.equal(contact.durationMin, 30);
    assert.deepEqual(contact.proposed, { from: "2026-10-05", to: "2026-10-11" });
    assert.equal(f.commands.length, 0);
    await hooks.before_prompt_build!({}, turn);
    await Promise.all([ask("rename", "Guest again"), ask("retry")]);
    assert.equal(sent.length, 1, "name corrections, parallel calls and uncertain sends must not repeat the owner ask");
    hooks.agent_end!({}, turn);
    turn.runId += "-next";
    await hooks.before_prompt_build!({}, turn);
    await ask("new-turn");
    assert.equal(sent.length, 2, "a new owner turn can ask again");
    t.diagnostic(JSON.stringify({ privateDm: sent[0].payloads[0].text, groupResult: result.details, delivery }));
  });
}

test("an existing owner-group offer still respects a do-not-contact flag", async t => {
  const f = fixture(t);
  f.ledger.blockedHandles = [context.requesterSenderId];
  f.save(f.ledger);
  const before = f.read();
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, { topic: "Lunch", durationMin: 30 });
  assert.equal("silent" in result && result.silent, true, JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(result), /do.?not.?contact|marked|blocked/i);
  const pending = f.request().pendingOwner;
  assert.ok(pending && "contact" in pending);
  assert.equal(pending.contact.topic, "Lunch");
  assert.equal(f.commands.some(c => ["create", "update", "delete"].includes(c[2]!)), false);
});

test("contact tools deny group and guest callers; private confirmation resumes the exact saved group request", async t => {
  const f = fixture(t);
  contactPreference({ handle: context.requesterSenderId, blocked: true });
  const owner = { ...context, senderIsOwner: true, requesterSenderId: "plow-owner", sessionKey: "agent:main:main" };
  const group = { ...owner, sessionKey: "agent:main:plow:group:chat-one" };
  await offerOwnerGroup(group, { topic: "Coffee", durationMin: 30, constraints: { days: ["mon"], from: "2026-10-05", to: "2026-10-05" } }, async () => {});
  const saved = f.request();
  assert.ok(saved.pendingOwner && "contact" in saved.pendingOwner);
  const contact = saved.pendingOwner.contact;
  for (const ctx of [group, { ...owner, senderIsOwner: false }, { ...owner, agentAccountId: "email" }, { ...owner, requesterSenderId: undefined }, owner]) {
    const tools = new Map<string, any>();
    registerContactTools({ registerTool(factory: any) { const tool = factory(ctx); tools.set(tool.name, tool); } }, async (action, args) =>
      action === "preference" ? contactPreference(args as any) : confirmContactOffer(args as any));
    const result = await tools.get("meetly_confirm_contact").execute("confirm", { requestId: saved.id, offered: offers.map(({ start, end }) => ({ start, end })).slice(0, 1) });
    if (ctx !== owner) {
      assert.equal(result.isError, true);
      const clear = await tools.get("meetly_contact_preference").execute("clear", { handle: saved.handle, blocked: false });
      assert.equal(clear.isError, true);
      assert.equal(f.request().contactApproved, undefined);
      assert.equal(f.commands.length, 0);
    } else {
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(f.request().chatUid, "chat-one");
      assert.equal(f.request().topic, "Coffee");
      assert.deepEqual(f.request().constraints, contact.constraints);
      f.ledger.requests[0]!.constraints = contact.constraints;
      assert.equal(f.request().pendingOwner, undefined);
      assert.equal(f.request().contactApproved, true);
      assert.equal(doNotContact(f.read(), saved.handle), true);
      const picked = await guestAction(context, "pick", { start: offers[0]!.start });
      assert.equal("status" in picked && picked.status, "booked", JSON.stringify(picked));
      t.diagnostic(JSON.stringify({ groupHandoff: contact, confirmed: result.details.request.id, guestBooking: picked }));
    }
  }
});

test("unmarked booked offers cannot be viewed, picked or expired as replacements", async t => {
  const f = fixture(t);
  await f.act(context, "pick", { start: offers[0]!.start });
  const request = { ...f.request(), offered: offers };
  delete request.bookedReplacement;
  f.save({ requests: [request] });
  const before = f.read(), commands = f.commands.length;
  const view = JSON.parse((await f.tools.get("meetly_view_request")!.execute("view", {})).content[0]!.text);
  assert.deepEqual(view.offered, []);
  const pick = await f.act(context, "pick", { start: offers[1]!.start });
  assert.match(JSON.stringify(pick), /Choose one of/);
  assert.deepEqual(expiredRequests(f.read(), 48, now + 49 * 3600_000), []);
  assert.deepEqual(f.read(), before);
  assert.equal(f.commands.length, commands);
  t.diagnostic(JSON.stringify({ view, pick }));
});

for (const start of ["thu", "Thursday", '{"weekday":"funday"}', { weekday: "Thursday" }])
test(`invalid starts separate guest correction from weekday retry: ${JSON.stringify(start)}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = {};
  f.save(f.ledger);
  const before = f.request();
  const tool = f.tools.get("meetly_other_times")!;
  const rejected = JSON.parse((await tool.execute("invalid", { offer_week: true, start })).content[0]!.text);
  assert.equal(rejected.code, "INVALID_START");
  if (typeof start === "string") {
    assert.equal(rejected.recovery.action, "reply");
    assert.match(rejected.recovery.message, /correct.*date.*time/i);
    assert.doesNotMatch(rejected.recovery.message, /nested weekday|retry/i);
  } else {
    assert.equal(rejected.recovery.action, "retry");
    assert.match(rejected.error, /weekday.*mon, tue, wed, thu, fri, sat, sun/);
    assert.match(rejected.error, /HH:MM/);
    assert.match(rejected.error, /ISO/);
  }
  assert.deepEqual(f.request(), before);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.ownerLines, []);
  if (typeof start === "string") return;
  const retried = JSON.parse((await tool.execute("retry", { offer_week: true, start: { weekday: "thu" } })).content[0]!.text);
  assert.ok(retried.offered.length, JSON.stringify(retried));
  assert.ok(retried.offered.every((slot: { start: string }) => slot.start.startsWith("2026-10-08")));
});

test("invalid-start tool guidance distinguishes dated errors from weekday arguments", () => {
  let description = "";
  registerGuestTools({ registerTool(factory: (ctx: object) => { name: string; description: string }) {
    const tool = factory({}); if (tool.name === "meetly_other_times") description = tool.description;
  } });
  assert.match(description, /invalid weekday arguments/);
  assert.match(description, /ask the guest to correct the explicit date\/time/);
  assert.match(description, /Never substitute a weekday/);
});

test("ask-owner rejects over-length text without effects", async t => {
  const f = fixture(t);
  const before = f.request();
  const tool = f.tools.get("meetly_ask_owner")!;
  assert.match(tool.parameters.properties.question!.description, /verbatim/);
  assert.match(tool.parameters.properties.question!.description, /ask the guest to shorten/i);
  const rejected = JSON.parse((await tool.execute("long", { question: "x".repeat(501) })).content[0]!.text);
  assert.match(rejected.error, /500 characters or fewer/);
  assert.deepEqual(f.request(), before);
  assert.equal(f.ownerLines.length, 0);
  assert.equal(f.deliveries.length, 0);

});

for (const [start, timezone] of [
  ["2026-11-31T10:00", "UTC"], ["2026-02-29T10:00:00Z", "UTC"],
  ["2026-10-05T24:00", "UTC"], ["2026-10-05T10:00:60", "UTC"],
  ["2026-10-05T10:00:00+25:00", "UTC"], ["2026-03-08T02:30", "America/New_York"],
]) test(`malformed exact start is rejected before effects: ${start}`, async t => {
  const f = fixture(t, undefined, timezone);
  const before = f.read();
  const result = JSON.parse((await f.tools.get("meetly_other_times")!.execute("invalid", { offer_week: false, start, excludedDays: ["wed"] })).content[0]!.text);
  assert.equal(result.code, "INVALID_START");
  assert.equal(result.recovery.action, "reply");
  assert.match(result.recovery.message, /correct.*date.*time/i);
  assert.doesNotMatch(result.recovery.message, /nested weekday|retry/i);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.ownerLines, []);
});

for (const time of [undefined, "11:00"]) test(`booked weekday replacements use the booking week: time=${time}`, async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "thu"], from: "2026-10-05", to: "2026-10-09", after: "10:00", before: "15:00" };
  f.save(f.ledger);
  await f.act(context, "pick", { start: offers[0]!.start });
  const booked = f.request().booked;
  assert.deepEqual(f.request().offered, []);
  const before = f.commands.length;
  const result = JSON.parse((await f.tools.get("meetly_other_times")!.execute("weekday", {
    offer_week: true, start: { weekday: "thu", ...(time ? { time } : {}) },
  })).content[0]!.text);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.ok(result.offered.length);
  assert.ok(result.offered.every((o: { start: string }) => o.start.startsWith("2026-10-08")));
  if (time) assert.equal(Date.parse(result.offered[0].start), Date.parse("2026-10-08T11:00:00Z"));
  assert.deepEqual(f.request().booked, booked);
  assert.equal(f.request().eventId, "hold-one");
  assert.equal(f.request().bookedReplacement, true);
  assert.ok(f.request().offered.every(o => o.holdId));
  assert.ok(f.commands.slice(before).every(c => c[2] !== "update" && c[2] !== "delete"));
  assert.equal(f.ownerLines.length, 0);
  t.diagnostic(JSON.stringify(result));
});
