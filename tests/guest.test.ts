import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerGuestTools } from "../plugin/guest-tools.js";
import { offerOwnerGroup } from "../skills/meetly/scripts/owner-group.ts";
import { registerOwnerGroupTool } from "../plugin/owner-tools.js";
import plugin from "../plugin/index.js";
import { calendarAction } from "../skills/meetly/scripts/calendar.ts";
import { guestAction, type GuestAction, type GuestArgs, type GuestContext } from "../skills/meetly/scripts/guest.ts";
import { addRequest, type Ledger, type Request } from "../skills/meetly/scripts/ledger.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { tmpHome } from "./helpers.ts";

const now = Date.parse("2026-10-02T08:00:00Z");
const context = { messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "chat-one", requesterSenderId: "+15551234567", config: {} };
const offers = [
  { start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", holdId: "hold-one", account: "owner@example.com" },
  { start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z", holdId: "hold-two", account: "owner@example.com" },
];
const actions: [GuestAction, GuestArgs][] = [
  ["view", {}], ["pick", { start: offers[0]!.start }], ["other_times", { after: "11:00" }],
  ["format", { format: "meet" }], ["ask_owner", { start: "2026-10-05T20:00" }], ["decline", {}],
];
type Event = { id: string; summary: string; status: string; start: { dateTime: string }; end: { dateTime: string }; hangoutLink?: string; location?: string; extendedProperties?: { private: { meetlyOperation: string } } };
const event = (id: string, start: string, end: string): Event => ({ id, summary: "PRIVATE CALENDAR TITLE", status: "confirmed", start: { dateTime: start }, end: { dateTime: end } });

function fixture(t: TestContext) {
  const home = tmpHome();
  const previousHome = process.env.MEETLY_HOME;
  const previousToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  process.env.MEETLY_HOME = home;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "fixture";
  t.mock.method(Date, "now", () => now);
  const config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: "owner@example.com",
    calendars: [{ account: "owner@example.com", id: "owner@example.com" }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  const ledger = addRequest({ requests: [] }, {
    origin: "owner", handle: context.requesterSenderId, chatUid: context.nativeChannelId, name: "Guest", topic: "Lunch",
    durationMin: 30, constraints: { days: ["mon", "tue"], after: "10:00", before: "15:00", from: "2026-10-05", to: "2026-10-06" },
    allowOverlap: ["approved"], offered: offers, format: "unknown", locale: "en-US",
  }, now, "request-one");
  const save = (value: Ledger) => writeJson(join(home, "ledger.json"), value);
  save(ledger);
  const read = () => readJson<Ledger>(join(home, "ledger.json"), { requests: [] });
  const events = new Map(offers.map(o => [o.holdId!, event(o.holdId!, o.start, o.end)]));
  const commands: string[][] = [];
  const fail = new Set<string>();
  const lost = new Set<string>();
  const hooks: { before?: (argv: string[]) => Promise<void> } = {};
  let nextId = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body));
    assert.equal(call.params.name, "plow_run_command");
    const argv: string[] = call.params.arguments.argv;
    commands.push(argv);
    await hooks.before?.(argv);
    const flag = (name: string) => argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? argv[argv.indexOf(name) + 1];
    let output: string;
    let exit_code = 0;
    const conflict = argv[2] === "create" && !argv.includes("--confirm-conflict") && [...events.values()].some(e =>
      e.status !== "cancelled" && Date.parse(e.start.dateTime) < Date.parse(flag("--to")!) && Date.parse(e.end.dateTime) > Date.parse(flag("--from")!));
    if (conflict || fail.has(argv[2]!) || fail.has(argv[4]!)) { output = "PRIVATE BACKEND ERROR owner@example.com"; exit_code = 1; }
    else if (argv[0] === "/bin/sh") output = "S|0\nR|1|Guest||\nP|1|+15551234567||\nE|1|guest@example.net||";
    else {
      assert.deepEqual(argv.slice(0, 2), ["plow-gog", "calendar"]);
      switch (argv[2]) {
        case "events": {
          const from = Date.parse(flag("--from")!); const to = Date.parse(flag("--to")!);
          output = JSON.stringify({ events: [...events.values()].filter(e => Date.parse(e.start.dateTime) < to && Date.parse(e.end.dateTime) > from) });
          break;
        }
        case "event": output = JSON.stringify({ event: events.get(argv[4]!) }); break;
        case "delete": {
          const e = events.get(argv[4]!); if (e) e.status = "cancelled";
          output = "deleted"; break;
        }
        case "create": case "update": {
          const id = argv[2] === "create" ? `new-${++nextId}` : argv[4]!;
          const e = events.get(id) ?? event(id, flag("--from")!, flag("--to")!);
          if (argv.includes("--from")) e.start.dateTime = flag("--from")!;
          if (argv.includes("--to")) e.end.dateTime = flag("--to")!;
          if (argv.includes("--with-meet")) e.hangoutLink = "https://meet.google.com/abc-defg-hij";
          if (argv.some(a => a.startsWith("--location="))) e.location = flag("--location");
          if (argv.includes("--private-prop")) e.extendedProperties = { private: { meetlyOperation: flag("--private-prop")!.split("=")[1]! } };
          e.status = "confirmed"; events.set(id, e); output = JSON.stringify({ event: e }); break;
        }
        default: throw new Error(`unexpected command ${JSON.stringify(argv)}`);
      }
    }
    if (lost.has(argv[2]!)) return new Response("", { status: 503 });
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code, output }) }] } });
  });
  t.after(() => {
    assert.deepEqual(readJson(join(home, "config.json"), {}), config);
    const request = read().requests.find(r => r.id === "request-one");
    if (request) {
      assert.deepEqual(request.constraints, ledger.requests[0]!.constraints);
      assert.deepEqual(request.allowOverlap, ["approved"]);
      assert.equal(request.durationMin, ledger.requests[0]!.durationMin);
    }
  });
  t.after(() => {
    if (previousHome === undefined) delete process.env.MEETLY_HOME; else process.env.MEETLY_HOME = previousHome;
    if (previousToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN; else process.env.PLOW_MCP_BRIDGE_TOKEN = previousToken;
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
  return { home, read, save, ledger, events, commands, fail, lost, hooks, tools, act, ownerLines, deliveries, routes, delivery, request: () => read().requests[0]! };
}

for (const [action, args] of actions) test(`${action} refuses missing or mismatched runtime sender/chat and ignores identity arguments`, async t => {
  const f = fixture(t);
  for (const ctx of [ {}, { ...context, requesterSenderId: "+15557654321" }, { ...context, nativeChannelId: "other-chat" },
    { ...context, messageChannel: "webchat" }, { ...context, agentAccountId: "email" }]) {
    const result = await guestAction(ctx, action, { ...args, ...context, id: "request-one", handle: context.requesterSenderId } as GuestArgs);
    assert.match(JSON.stringify(result), /No scheduling request matches/);
  }
  assert.deepEqual(f.read(), f.ledger);
  assert.deepEqual(f.commands, []);
});

for (const [action, args] of actions) test(`${action} links the sender's unlinked offer and touches only that request`, async t => {
  const f = fixture(t);
  delete f.ledger.requests[0]!.chatUid;
  f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "other", chatUid: "other-chat", handle: "+15557654321" });
  f.save(f.ledger);
  const result = await f.act(context, action, args);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().chatUid, context.nativeChannelId);
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|owner@example.com|hold-one|hold-two|approved/);
});

test("other-times guidance reports automatic approval delivery instead of a second ask", () => {
  let description = "";
  registerGuestTools({ registerTool(factory: (ctx: object) => { name: string; description: string }) {
    const tool = factory(context); if (tool.name === "meetly_other_times") description = tool.description;
  } });
  assert.match(description, /automatically asks the owner/);
  assert.match(description, /ownerAskSent is true/);
  assert.match(description, /ask for a specific date and time if needed/);
});

for (const args of [
  { start: "2026-10-05T20:00" },
  { from: "2026-10-05", to: "2026-10-05", after: "20:00", before: "20:30" },
]) test(`other-times files a free outside-window approval without replacing holds: ${JSON.stringify(args)}`, async t => {
  const f = fixture(t);
  const tool = f.tools.get("meetly_other_times")!;
  const result = JSON.parse((await tool.execute("ask", args)).content[0]!.text);
  assert.equal(result.ownerAskSent, true);
  assert.match(result.message, /asked Alex/);
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
  const result = await f.act(context, "other_times", { start: "2026-10-05T11:00" });
  assert.ok(!("error" in result));
  assert.deepEqual(f.request().offered.map(o => o.start), ["2026-10-05T11:00:00+00:00"]);
  assert.equal(f.ownerLines.length, 0);
});

test("guest date bounds survive fallback when the preferred clock time is unavailable", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = {};
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { from: "2026-10-05", to: "2026-10-11", after: "20:00" });
  assert.ok(!("error" in result));
  assert.ok(f.request().offered.every(o => o.start.slice(0, 10) >= "2026-10-05" && o.start.slice(0, 10) <= "2026-10-11"));
  assert.equal(f.ownerLines.length, 0, "a broad preference is not an exact time approval");
});

test("an unavailable guest week falls back to the owner's conditions alone", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-14", after: "10:00", before: "15:00" };
  f.save(f.ledger);
  f.events.set("week", event("week", "2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z"));
  const result = await f.act(context, "other_times", { from: "2026-10-05", to: "2026-10-11" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.deepEqual(f.request().constraints, f.ledger.requests[0]!.constraints);
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(["2026-10-12", "2026-10-13", "2026-10-14"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
  }
  assert.equal(f.ownerLines.length, 0);
});

test("other-times automatically sends a lunch-window approval even inside working hours", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.meal = "lunch";
  f.ledger.requests[0]!.durationMin = 60;
  f.save(f.ledger);
  const result = await f.tools.get("meetly_other_times")!.execute("ask", {
    days: ["tue"], from: "2026-10-06", to: "2026-10-06", after: "15:00", before: "16:00",
  });
  assert.equal(JSON.parse(result.content[0]!.text).ownerAskSent, true);
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(f.request().offered, offers);
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-06T15:00:00+00:00", end: "2026-10-06T16:00:00+00:00", askedAt: new Date(now).toISOString() });
});

for (const failure of ["busy", "calendar", "delivery"] as const) test(`outside-window approval never claims an owner ask on ${failure}`, async t => {
  const f = fixture(t);
  if (failure === "busy") f.events.set("busy", event("busy", "2026-10-05T20:00:00Z", "2026-10-05T21:00:00Z"));
  if (failure === "calendar") f.fail.add("events");
  if (failure === "delivery") f.delivery.status = "queued";
  const tool = f.tools.get(failure === "busy" ? "meetly_ask_owner" : "meetly_other_times")!;
  const result = JSON.parse((await tool.execute("ask", { start: "2026-10-05T20:00" })).content[0]!.text);
  assert.ok(result.error);
  assert.notEqual(result.ownerAskSent, true);
  assert.equal(result.message, undefined);
  assert.equal(f.deliveries.length, failure === "delivery" ? 1 : 0);
  assert.deepEqual(f.request().offered, offers);
});

test("owner questions relay the guest's own words and delivery claims require a sent ask", () => {
  let description = "";
  registerGuestTools({ registerTool(factory: (ctx: object) => { name: string; description: string }) {
    const tool = factory(context); if (tool.name === "meetly_ask_owner") description = tool.description;
  } });
  assert.match(description, /Never invent a question or turn your own uncertainty into a guest question/);
  assert.match(description, /ownerAskSent is true/);
  assert.match(description, /Do not paraphrase or add a guest-asks prefix/);
});

test("decline requires the guest's clear refusal, never an other-times refusal", () => {
  const descriptions = new Map<string, string>();
  registerGuestTools({ registerTool(factory: (ctx: object) => { name: string; description: string }) {
    const tool = factory(context); descriptions.set(tool.name, tool.description);
  } });
  assert.match(descriptions.get("meetly_decline")!, /Only use when the guest clearly declines the meeting/);
  assert.match(descriptions.get("meetly_decline")!, /A refusal from meetly_other_times is not a guest decline/);
});

test("ordinary plugin tool factories retain context, have no identity arguments, and declare their contracts", () => {
  const names: string[] = [];
  const hooks: string[] = [];
  plugin.register({ on(name: string) { hooks.push(name); }, registerTool(factory: (ctx: object) => { name: string; parameters: { properties: object } }) {
    const tool = factory(context); names.push(tool.name);
    if (tool.name !== "meetly_offer_owner_group") assert.ok(!Object.keys(tool.parameters.properties).some(k => ["id", "handle", "chatUid", "sender", "account", "allowOverlap", "constraints"].includes(k)));
  } });
  assert.deepEqual(names, JSON.parse(readFileSync(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8")).contracts.tools);
  assert.deepEqual(hooks, ["before_prompt_build"]);
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
  await guestAction(context, "decline");
  assert.equal(f.request().status, "dropped"); assert.equal(f.request().pendingOwner, undefined);
  assert.deepEqual(f.request().holdCleanup, [{ holdId: "hold-two", account: "owner@example.com" }]);
  assert.equal(f.commands.filter(c => c[2] === "delete").length, 2);
});

test("an outside-hours refusal can proceed to owner approval without dropping or booking the request", async t => {
  const f = fixture(t);
  for (const date of ["2026-10-05", "2026-10-06"]) f.events.set(date, event(date, `${date}T09:00:00Z`, `${date}T18:00:00Z`));
  const refused = await guestAction(context, "other_times", { after: "20:00" });
  assert.ok("error" in refused);
  assert.deepEqual(f.read(), f.ledger);
  const result = await f.act(context, "ask_owner", { start: "2026-10-05T20:00" });
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
  f.commands.length = 0;
  const result = await guestAction(context, "format", { format: "meet" });
  assert.equal(f.request().format, "meet"); assert.equal(f.request().meetUrl, "https://meet.google.com/abc-defg-hij");
  const writes = f.commands.filter(c => c[2] === "update");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![4], "hold-one");
  assert.ok(writes[0]!.includes("--with-meet"));
  assert.equal(f.events.get("hold-one")!.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/meet|PRIVATE/);
});

for (const status of ["booked", "dropped", "expired"] as const) test(`${status} stays this chat's request; guest cannot rebook or cancel it`, async t => {
  const f = fixture(t); f.ledger.requests[0]!.status = status; f.save(f.ledger);
  for (const [action, args] of actions.filter(([a]) => a !== "format")) {
    const result = await f.act(context, action, args);
    assert.equal((result as { status: string }).status, status);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.read(), f.ledger);
});

test("calendar failure leaks no event data and leaves the offer untouched", async t => {
  const f = fixture(t); f.fail.add("events");
  for (const action of ["pick", "other_times", "ask_owner"] as const) {
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

test("an unlinked replacement supersedes a closed request and collected turns retain their runtime chat", async t => {
  const f = fixture(t);
  delete f.ledger.requests[0]!.chatUid;
  f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "old", status: "dropped", chatUid: context.nativeChannelId }); f.save(f.ledger);
  const result = await guestAction({ ...context, nativeChannelId: undefined, deliveryContext: { to: `plow:${context.nativeChannelId}` } }, "format", { format: "phone" });
  assert.ok(!("error" in result)); assert.equal(f.request().format, "phone"); assert.equal(f.request().chatUid, context.nativeChannelId);
  assert.deepEqual(f.read().requests[1], f.ledger.requests[1]);
});

for (const action of ["pick", "ask_owner"] as const) test(`${action} cannot bypass the current offer or authorize a busy time`, async t => {
  const f = fixture(t);
  const start = action === "pick" ? "2026-10-05T12:00:00Z" : "2026-10-05T20:00:00Z";
  f.events.set("conflict", event("private", start, start.replace(":00:00Z", ":30:00Z")));
  const result = await guestAction(context, action, { start });
  assert.ok("error" in result); assert.deepEqual(f.read(), f.ledger);
  assert.ok(f.commands.every(c => c[2] === "events"));
});

test("a rejected weekday preference without date bounds returns fresh times within the owner's conditions", async t => {
  const f = fixture(t);
  const result = await guestAction(context, "other_times", { days: ["thu"], after: "16:00", before: "18:00" });
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

test("a Thursday counterproposal falls back to the owner's Monday-Wednesday conditions", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.constraints = { days: ["mon", "tue", "wed"], from: "2026-10-05", to: "2026-10-07", after: "10:00", before: "15:00" };
  f.save(f.ledger);
  const result = await f.act(context, "other_times", { days: ["thu"], from: "2026-10-08", to: "2026-10-08", after: "16:00", before: "18:00" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("preferencesUnavailable" in result && result.preferencesUnavailable, true);
  assert.deepEqual(f.request().constraints, f.ledger.requests[0]!.constraints);
  assert.equal(f.request().status, "offered");
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(["2026-10-05", "2026-10-06", "2026-10-07"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
    assert.ok(!offers.some(old => Date.parse(old.start) === Date.parse(offer.start)));
  }
  assert.ok(offers.every(old => f.events.get(old.holdId)!.status === "cancelled"));
  assert.equal(f.ownerLines.length, 0);
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

for (const sender of ['+115551234567', '5551234567', '+15551234567junk']) test(`suffix or malformed identity ${sender} is refused by every guest tool`, async t => {
  const f = fixture(t);
  for (const [action, args] of actions) assert.match(JSON.stringify(await guestAction({ ...context, requesterSenderId: sender }, action, args)), /No scheduling request matches/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.read(), f.ledger);
});

test('native chat uid is exact, without stripping a transport prefix', async t => {
  const f = fixture(t);
  assert.match(JSON.stringify(await guestAction({ ...context, nativeChannelId: `plow:${context.nativeChannelId}` }, 'view')), /No scheduling request matches/);
  assert.deepEqual(f.read(), f.ledger);
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
  const result = await guestAction(context, action, { start: offers[0]!.start, after: '11:00' });
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

for (const kind of ["question", "time"] as const) test(`ask-owner accepts an empty unused field for a ${kind}`, async t => {
  const f = fixture(t);
  const args = kind === "question" ? { start: "", question: "Should I bring the budget numbers?" }
    : { start: "2026-10-05T20:00", question: "  " };
  const result = await f.tools.get("meetly_ask_owner")!.execute("ask", args);
  assert.doesNotMatch(result.content[0]!.text, /error/);
  assert.equal(f.deliveries.length, 1);
  assert.ok(f.request().pendingOwner);
  assert.equal("question" in f.request().pendingOwner!, kind === "question");
});

test("questions and time approvals share one slot, including concurrent asks", async t => {
  const f = fixture(t);
  const ask = f.tools.get("meetly_ask_owner")!;
  const results = await Promise.all([ask.execute("one", { start: "2026-10-05T20:00" }), ask.execute("two", { question: "Which project?" })]);
  assert.equal(results.filter(r => /error/.test(r.content[0]!.text)).length, 1);
  assert.equal(f.deliveries.length, 1);
  const pending = f.request().pendingOwner;
  const result = await ask.execute("three", { start: "2026-10-06T20:00" });
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
  for (const args of [{}, { question: " " }, { question: 123 }, { question: "Where?", start: offers[0]!.start }]) {
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

test('an owner-approved time is booked and cleared by the seam', async t => {
  const f = fixture(t);
  await f.act(context, 'ask_owner', { start: '2026-10-05T20:00' });
  const pending = f.request().pendingOwner!;
  assert.ok('start' in pending);
  await calendarAction('request-one', { action: 'book', start: pending.start, end: pending.end });
  assert.equal(f.request().booked!.start, pending.start);
  assert.equal(f.request().pendingOwner, undefined);
  assert.ok(f.request().calendarRevision);
  assert.equal(f.ownerLines.length, 1);
});

test("a blank question cannot store a time approval on a booked meeting", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.status = "booked";
  f.save(f.ledger);
  await f.act(context, "ask_owner", { start: "2026-10-05T20:00", question: "  " });
  assert.equal(f.request().pendingOwner, undefined);
  assert.deepEqual(f.ownerLines, []);
  assert.deepEqual(f.commands, []);
  const next = await f.act(context, "ask_owner", { question: "Which entrance?" });
  assert.ok(!("error" in next));
  assert.equal(f.ownerLines.length, 1);
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
  const args = { handle: context.requesterSenderId, topic: "Planning", constraints: { days: [], after: "", before: "", from: "", to: "" },
    proposed: { days: ["tue"], from: "2026-10-06", to: "2026-10-06", after: "", before: "" }, offered: offers.map(({ start, end }) => ({ start, end, account: "injected@example.net", holdId: "injected-hold" })), chatUid: "other-group" };
  const result = await tool.execute("offer", args);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.request().chatUid, "cht_MiXeD");
  assert.equal(f.request().origin, "owner-group");
  assert.equal(f.request().durationMin, DEFAULTS.durationMin);
  assert.ok(f.request().offered.every(o => o.account === "owner@example.com" && o.holdId !== "injected-hold"));
  assert.equal(result.details.ownerName, "Alex");
  assert.equal(result.details.offered.length, 2);
  assert.equal(result.content[0].text, JSON.stringify(result.details));
  assert.doesNotMatch(JSON.stringify(result), /account|holdId|calendarRevision|chatUid|example\.com|injected|new-\d|r_[a-f0-9]/);
  assert.equal(tool.parameters.properties.offered.items.properties.account, undefined);
  assert.ok(!tool.parameters.properties.offered.items.required.includes("account"));
  assert.ok(!tool.parameters.required.includes("durationMin"));
  assert.equal(f.request().constraints, undefined);
  assert.deepEqual(f.request().proposed, { days: ["tue"], from: "2026-10-06", to: "2026-10-06" });
  assert.ok("error" in await guestAction({ ...context, nativeChannelId: "other-group" }, "view"));
  assert.ok("error" in await guestAction({ ...context, nativeChannelId: "cht_mixed" }, "view"));
  assert.ok(!("error" in await guestAction({ ...context, nativeChannelId: "cht_MiXeD" }, "view")));
});

test("the owner-group tool refuses guests, DMs and requests already linked elsewhere", async t => {
  const f = fixture(t);
  const args = { ...f.ledger.requests[0]!, offered: offers.map(({ holdId, ...slot }) => slot) };
  const ctx = { ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" };
  for (const invalid of [{ ...ctx, senderIsOwner: false }, { ...ctx, sessionKey: "agent:main:main" },
    { ...ctx, nativeChannelId: undefined }, { ...ctx, agentAccountId: "email" }, { ...ctx, nativeChannelId: "elsewhere" }]) {
    assert.ok("error" in await offerOwnerGroup(invalid, args));
  }
  assert.deepEqual(f.read(), f.ledger);
  assert.equal(f.commands.length, 0);
});


test("owner-group failures never echo private validation details", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { ...f.ledger.requests[0]!, offered: offers.map(({ holdId, ...slot }) => slot) },
    { validate() { throw new Error("PRIVATE CALENDAR TITLE owner@example.com hold-one"); } });
  assert.ok("error" in result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|example\.com|hold-one/);
  assert.equal(f.commands.length, 0);
});

test("owner-group conflict authorization resolves only named events and stays private", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  f.events.clear();
  for (const [i, slot] of offers.entries()) f.events.set(`private-approved-${i}`, { ...event(`private-approved-${i}`, slot.start, slot.end), summary: "Weekly Claw" });
  f.events.set("private-unapproved", { ...event("private-unapproved", offers[1]!.start, offers[1]!.end), summary: "Weekly Claw extra" });
  let tool: any;
  registerOwnerGroupTool({ registerTool(factory: any) { tool = factory({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" }); } }, offerOwnerGroup);
  f.hooks.before = async argv => {
    if (argv[2] === "create") assert.deepEqual(f.request().allowOverlap, ["private-approved-0", "private-approved-1"], "persist authorization before writing holds");
  };
  const result = await tool.execute("offer", { handle: context.requesterSenderId, topic: "Lunch", allowOverlapTitles: ["Weekly Claw"],
    allowOverlap: ["private-unapproved"], offered: offers.map(({ start, end }) => ({ start, end })) });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(f.request().allowOverlap, ["private-approved-0", "private-approved-1"]);
  assert.deepEqual(f.request().offered.map(o => o.start), [offers[0]!.start]);
  assert.equal(f.commands.filter(c => c[2] === "create").length, 1);
  assert.ok(f.commands.find(c => c[2] === "create")!.includes("--confirm-conflict"));
  assert.equal(tool.parameters.properties.allowOverlap, undefined);
  assert.equal(tool.parameters.properties.allowOverlapTitles.items.type, "string");
  assert.doesNotMatch(JSON.stringify(result), /private-|Weekly Claw|Weekly Claw extra|allowOverlap|owner@example.com/);
});

for (const question of ['"Should I bring the budget numbers?"', '“Should I bring the budget numbers?”', '\'“Should I bring the budget numbers?”\'']) test(`ask-owner quotes once: ${question}`, async t => {
  const f = fixture(t);
  await f.act(context, "ask_owner", { question });
  assert.deepEqual(f.request().pendingOwner, { question: "Should I bring the budget numbers?", askedAt: new Date(now).toISOString() });
  assert.deepEqual(f.ownerLines, ['Guest in your Lunch group asks: "Should I bring the budget numbers?" — what should I tell them?']);
});


test("guests can re-offer and book dinner but cannot widen its meal window", async t => {
  const f = fixture(t);
  const request = f.ledger.requests[0]!;
  request.meal = "dinner";
  request.durationMin = 60;
  request.constraints = { days: ["mon", "tue"], from: "2026-10-05", to: "2026-10-06" };
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { after: "17:00", before: "23:00" });
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
  assert.deepEqual(f.ownerLines, ['Guest in your 60-minute call group asks: "Should I bring the budget numbers?" — what should I tell them?']);
});

test("an owner duration change keeps an unanswered opener question suppressed on guest re-offers", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.detailsAskedAt = new Date(now).toISOString();
  f.ledger.requests[0]!.durationMin = 60;
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { days: ["tue"] });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal("detailsQuestion" in result && result.detailsQuestion, null);
  assert.equal(f.request().detailsAskedAt, new Date(now).toISOString());
  assert.equal(f.request().format, "unknown");
  assert.equal(f.request().durationMin, 60);
});


test("lunch approval describes the meal window even within configured working hours", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.meal = "lunch";
  f.ledger.requests[0]!.durationMin = 60;
  f.save(f.ledger);
  const within = await f.act(context, "ask_owner", { start: "2026-10-05T12:00:00Z" });
  assert.match(JSON.stringify(within), /within the meeting window/);
  await f.act(context, "ask_owner", { start: "2026-10-05T10:30:00Z" });
  assert.match(f.ownerLines[0]!, /outside the meeting window/);
  assert.doesNotMatch(f.ownerLines[0]!, /working hours/);
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-05T10:30:00+00:00", end: "2026-10-05T11:30:00+00:00", askedAt: new Date(now).toISOString() });
});


test("owner-group lunch resolves its default duration without model-supplied config", async t => {
  const f = fixture(t);
  f.save({ requests: [] });
  f.events.clear();
  const result = await offerOwnerGroup({ ...context, senderIsOwner: true, sessionKey: "agent:main:plow:group:chat-one" },
    { handle: context.requesterSenderId, topic: "Lunch", meal: "lunch", offered: [{ start: "2026-10-05T12:00:00Z", end: "2026-10-05T13:00:00Z" }] });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().meal, "lunch");
  assert.equal(f.request().durationMin, 60);
  assert.equal(f.request().offered[0]!.account, "owner@example.com");
});
