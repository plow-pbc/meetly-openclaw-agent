import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerGuestTools } from "../plugin/guest-tools.js";
import type { Participant } from "../skills/meetly/scripts/owner-chat.ts";
import { offerOwnerGroup } from "../skills/meetly/scripts/owner-group.ts";
import { registerOwnerGroupTool, registerOwnerDmTool } from "../plugin/owner-tools.js";
import plugin from "../plugin/index.js";
import { calendarAction, offerRequest } from "../skills/meetly/scripts/calendar.ts";
import { guestAction, type GuestAction, type GuestArgs, type GuestContext } from "../skills/meetly/scripts/guest.ts";
import { addRequest, type Ledger, type Request } from "../skills/meetly/scripts/ledger.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { DEFAULTS, SLOT_COUNT } from "../skills/meetly/scripts/config.ts";
import { calendarEvent as event, fakeCalendar, cli, tmpHome } from "./helpers.ts";

const now = Date.parse("2026-10-02T08:00:00Z");
const context = { messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "chat-one", requesterSenderId: "+15551234567", config: {} };
const offers = [
  { start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", holdId: "hold-one", account: "owner@example.com" },
  { start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", holdId: "hold-two", account: "owner@example.com" },
];
const actions: [GuestAction, GuestArgs][] = [
  ["view", {}], ["pick", { start: offers[0]!.start }], ["other_times", { after: "11:00" }],
  ["format", { format: "meet" }], ["ask_owner", { question: "Which entrance?" }], ["decline", {}],
];

function fixture(t: TestContext, contactOutput = "S|0\nR|1|Guest||\nP|1|+15551234567||\nE|1|guest@example.net||") {
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
  const config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: "owner@example.com",
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  const ledger = addRequest({ requests: [] }, {
    origin: "owner", handle: context.requesterSenderId, chatUid: context.nativeChannelId, name: "Guest", topic: "Lunch",
    durationMin: 30, constraints: { days: ["mon", "tue"], after: "10:00", before: "15:00", from: "2026-10-05", to: "2026-10-06" },
    allowOverlap: [{ account: "owner@example.com", id: "approved" }], offered: offers, format: "unknown", locale: "en-US",
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
      assert.deepEqual(request.allowOverlap, [{ account: "owner@example.com", id: "approved" }]);
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
      assert.ok(read().requests[0]!.pendingOwner, "save the question before sending");
      deliveries.push(args);
      if (delivery.fail) throw new Error("PRIVATE TRANSPORT ERROR");
      ownerLines.push(args.payloads[0].text);
      return { status: delivery.status };
    },
  });
  const tools = new Map<string, { execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> }>();
  registerGuestTools({ runtime: { channel: {
    routing: { resolveAgentRoute(args: object) {
      assert.deepEqual(args, { cfg: context.config, channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } });
      return ownerRoute;
    } },
    session: { resolveStorePath: () => "/sessions", updateLastRoute: async (args: Record<string, any>) => { routes.push(args); } },
  } }, registerTool(factory: (ctx: GuestContext) => { name: string; execute: (id: string, args: object) => Promise<{ content: { text: string }[] }> }) {
    const tool = factory(context); tools.set(tool.name, tool);
  } }, guestAction, outbound);
  const act = (ctx: GuestContext, action: GuestAction, args: GuestArgs = {}) => guestAction(ctx, action, args, sendOwner);
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
  const args = { start: "2026-10-05T20:00" };
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
  const result = await f.act(context, "other_times", { start: "2026-10-05T11:15" });
  assert.ok(!("error" in result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, false);
  assert.deepEqual(f.request().offered.map(o => [o.start, o.end]), [["2026-10-05T11:15:00+00:00", "2026-10-05T11:45:00+00:00"]]);
  assert.equal(f.ownerLines.length, 0);
});

for (const reason of ["busy", "owner constraints"] as const) test(`an exact other-times request falls back when blocked by ${reason}`, async t => {
  const f = fixture(t);
  if (reason === "busy") f.events.set("conflict", event("conflict", "2026-10-05T11:15:00Z", "2026-10-05T11:45:00Z"));
  else { f.ledger.requests[0]!.constraints!.after = "12:00"; f.save(f.ledger); }
  const result = await f.act(context, "other_times", { start: "2026-10-05T11:15" });
  assert.ok(!("error" in result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.ok(f.request().offered.every(o => o.start !== "2026-10-05T11:15:00+00:00"));
  assert.equal(f.ownerLines.length, 0);
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
  assert.match(descriptions.get("meetly_other_times")!, /ask for a specific date and time if needed/);
  assert.match(descriptions.get("meetly_ask_owner")!, /Never invent a question or turn your own uncertainty into a guest question/);
  assert.match(descriptions.get("meetly_ask_owner")!, /ownerAskSent is true/);
  assert.match(descriptions.get("meetly_ask_owner")!, /Do not paraphrase or add a guest-asks prefix/);
});

test("ordinary plugin tool factories retain context, have no identity arguments, and declare their contracts", () => {
  const names: string[] = [];
  const hooks: string[] = [];
  plugin.register({ on(name: string) { hooks.push(name); }, registerTool(factory: (ctx: object) => { name: string; parameters: { properties: object; required: string[] } }) {
    const tool = factory(context); names.push(tool.name);
    if (tool.name === "meetly_ask_owner") {
      assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
      assert.deepEqual(tool.parameters.required, ["question"]);
    }
    if (!["meetly_offer_owner_group", "meetly_offer_owner_dm"].includes(tool.name)) assert.ok(!Object.keys(tool.parameters.properties).some(k => ["id", "handle", "chatUid", "sender", "account", "allowOverlap", "constraints"].includes(k)));
  } });
  assert.deepEqual(names, JSON.parse(readFileSync(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8")).contracts.tools);
  assert.deepEqual(hooks, ["before_prompt_build"]);
});

test("blank optional preferences through the guest tool still produce fresh held times", async t => {
  const f = fixture(t);
  const result = await f.tools.get("meetly_other_times")!.execute("call", {
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
  const f = fixture(t, "S|0\nR|1|Other|Person|\nP|1|(555) 123-4567||\nE|1|wrong@example.net||");
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
  const result = await guestAction(context, "other_times", { days: ["mon", "tue", "wed"], after: "09:00", before: "12:00", from: "2026-10-01", to: "2026-10-31" });
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
  const refused = await guestAction(context, "other_times", { after: "20:00" });
  assert.ok("error" in refused);
  assert.deepEqual(f.read(), f.ledger);
  const result = await f.act(context, "other_times", { start: "2026-10-05T20:00" });
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

for (const status of ["booked", "dropped", "expired"] as const) test(`${status} stays this chat's request; guest cannot rebook or cancel it`, async t => {
  const f = fixture(t); f.ledger.requests[0]!.status = status; f.ledger.requests[0]!.format = "phone"; f.save(f.ledger);
  for (const [action, args] of actions.filter(([a]) => a !== "format" && !(status === "booked" && a === "ask_owner"))) {
    const result = await f.act(context, action, args);
    assert.equal((result as { status: string }).status, status);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.read(), f.ledger);
});

test("calendar failure leaks no event data and leaves the offer untouched", async t => {
  const f = fixture(t); f.fail.add("events");
  for (const action of ["pick", "other_times"] as const) {
    const result = await guestAction(context, action, { start: offers[0]!.start });
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

test("a rejected Thursday counterproposal returns fresh times within the owner's conditions", async t => {
  const f = fixture(t);
  const result = await guestAction(context, "other_times", { days: ["thu"], from: "2026-10-08", to: "2026-10-08", after: "16:00", before: "18:00" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.deepEqual(f.request().constraints, f.ledger.requests[0]!.constraints);
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(["2026-10-05", "2026-10-06"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
    assert.ok(!offers.some(old => Date.parse(old.start) === Date.parse(offer.start)));
  }
  assert.ok(offers.every(old => f.events.get(old.holdId)!.status === "cancelled"));
});

test("no fallback availability leaves the existing offer and holds intact", async t => {
  const f = fixture(t);
  f.events.set("busy", event("busy", "2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z"));
  const result = await guestAction(context, "other_times", { days: ["wed"] });
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
  const result = await guestAction(context, "other_times", { after: "10:30", before: "11:30" });
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
  const result = await guestAction(context, 'other_times', { after: '11:00' });
  assert.ok('error' in result);
  assert.deepEqual(f.request().offered, offers);
  assert.equal(f.events.get('hold-one')!.status, 'confirmed');
  assert.equal(f.events.get('hold-two')!.status, 'confirmed');
  assert.ok(f.commands.every(c => c[2] !== 'delete'));
});

for (const action of ['pick', 'other_times'] as const) test(`guest ${action} reconciles a lost write response through the writer`, async t => {
  const f = fixture(t); f.lost.add(action === 'pick' ? 'update' : 'create');
  const result = await guestAction(context, action, action === 'pick' ? { start: offers[0]!.start } : { after: '11:00' });
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

test("ask-owner sends a capped human question to the fixed owner DM and mirrors the owner session", async t => {
  const f = fixture(t);
  const question = 'Could we discuss "the new project"? ' + "x".repeat(600);
  const result = await f.tools.get("meetly_ask_owner")!.execute("ask", { question, to: "intruder", chatUid: "intruder" });
  assert.doesNotMatch(JSON.stringify(result), /error|intruder/);
  const saved = { question: question.slice(0, 500), askedAt: new Date(now).toISOString() };
  assert.deepEqual(f.request().pendingOwner, saved);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.ownerLines, [`Guest in your Lunch group asks: ${JSON.stringify(saved.question)} — what should I tell them?`]);
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
  const results = await Promise.all([times.execute("one", { start: "2026-10-05T20:00" }), ask.execute("two", { question: "Which project?" })]);
  assert.equal(results.filter(r => /error/.test(r.content[0]!.text)).length, 1);
  assert.equal(f.deliveries.length, 1);
  const pending = f.request().pendingOwner;
  const result = await times.execute("three", { start: "2026-10-06T20:00" });
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
  assert.match(JSON.stringify(await f.act({ ...context, nativeChannelId: "other-chat" }, "ask_owner", { question: "Where?" })), /No scheduling request/);
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
  const args = { handle: context.requesterSenderId, topic: "Planning", name: "", format: "", location: "", locale: "", durationMin: "", offered: offers.map(({ start, end }) => ({ start, end, account: "injected@example.net", holdId: "injected-hold" })), chatUid: "other-group" };
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
  assert.ok(!tool.parameters.required.includes("durationMin"));
  assert.deepEqual(tool.parameters.properties.constraints.properties.days.items.enum, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(tool.parameters.properties.constraints.properties.after.description, "Earliest time, HH:MM.");
  assert.equal(tool.parameters.properties.proposed, tool.parameters.properties.constraints);
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
  const result = await tool.execute("offer", { topic: "Planning", proposed: { days: ["sat"], after: "20:00" }, offered: injected });
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
  const result = await tool.execute("offer", { topic: "Lunch", allowOverlapTitles: ["Weekly Claw"],
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
  f.events.clear();
  for (const [i, slot] of offers.entries()) f.events.set(`private-approved-${i}`, { ...event(`private-approved-${i}`, slot.start, slot.end), summary: "Weekly Claw" });
  f.events.set("private-unapproved", { ...event("private-unapproved", offers[1]!.start, offers[1]!.end), summary: "Weekly Claw extra" });
  let tool: any;
  registerOwnerDmTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:main" }); } }, offerRequest);
  const result = await tool.execute("offer", { origin: "owner", handle: context.requesterSenderId, topic: "Lunch",
    allowOverlapTitles: ["Weekly Claw"], offered: offers.map(({ start, end }) => ({ start, end })) });
  assert.equal(result.isError, false, JSON.stringify(result));
  const { request } = result.details as { request: Request };
  assert.deepEqual(request.allowOverlap, ["private-approved-0", "private-approved-1"].map(id => ({ account: "owner@example.com", id })));
  assert.deepEqual(request.offered.map(o => o.start), [offers[0]!.start]);
  const creates = f.commands.filter(c => c[2] === "create");
  assert.equal(creates.length, 1);
  assert.ok(creates[0]!.includes("--confirm-conflict"));
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
    { topic: asked.topic, constraints: asked.constraints });
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
  assert.ok(!("error" in await guestAction(context, "other_times", { after: "11:00" })));
  assert.equal((await guestAction(context, "view") as { askDetails: boolean }).askDetails, false);
  assert.ok(!("error" in await guestAction(context, "pick", { start: f.request().offered[0]!.start })));
  assert.equal((await guestAction(context, "view") as { askDetails: boolean }).askDetails, false);
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
  const args = { handle: "+15557654321", topic: "Lunch", offered: offers };
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
  const args = { handle: context.requesterSenderId, name: "Alder", topic: "Lunch", offered: offers };
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
    { topic: "Lunch" });
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

test("owner-group ignores model duration and saves the owner's guest name for DM lookup", async t => {
  const f = fixture(t, "");
  f.save({ requests: [] });
  f.events.clear();
  f.participants[2]!.display_name = "unnamed member";
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  const result = await tool.execute("offer", { topic: "call", name: "Bo", durationMin: 1 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.request().durationMin, DEFAULTS.durationMin);
  assert.equal(tool.parameters.properties.durationMin, undefined);
  assert.equal(f.request().name, "Bo");
  assert.ok(f.request().offered.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === DEFAULTS.durationMin * 60_000));
  const found = cli("ledger.ts", ["find", "--name", " bo "], { MEETLY_HOME: f.home });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.json.request.id, f.request().id);
  assert.equal(found.json.request.chatUid, "chat-one");
});

test("owner-group busy requested times rank nearby alternatives while retaining hard bounds", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  f.events.set("busy", event("busy", "2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z"));
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }, {
    topic: "call", constraints: { days: ["tue"], from: "2026-10-06", to: "2026-10-13", after: "11:00", before: "15:00" },
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
  const result = await f.act(context, "other_times", { start: "2026-10-08T20:00:00Z" });
  assert.match(JSON.stringify(result), /time.*outside.*owner.*conditions/i);
  assert.deepEqual(f.read(), before);
  assert.equal(f.ownerLines.length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

test("owner-group duration steering atomically replaces holds in the same chat", async t => {
  const f = fixture(t);
  f.save({ requests: [] }); f.events.clear();
  const ctx = { ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" };
  assert.ok(!("error" in await offerOwnerGroup(ctx, { topic: "30-minute call" })));
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
