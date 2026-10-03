import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerGuestTools } from "../plugin/guest-tools.js";
import plugin from "../plugin/index.js";
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
type Event = { id: string; summary: string; status: string; start: { dateTime: string }; end: { dateTime: string }; hangoutLink?: string; location?: string };
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
  let nextId = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body));
    assert.equal(call.params.name, "plow_run_command");
    const argv: string[] = call.params.arguments.argv;
    commands.push(argv);
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
          e.status = "confirmed"; events.set(id, e); output = JSON.stringify({ event: e }); break;
        }
        default: throw new Error(`unexpected command ${JSON.stringify(argv)}`);
      }
    }
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
  return { home, read, save, ledger, events, commands, fail, tools, act, ownerLines, deliveries, routes, delivery, request: () => read().requests[0]! };
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

test("ordinary plugin tool factories retain context, have no identity arguments, and declare their contracts", () => {
  const names: string[] = [];
  const hooks: string[] = [];
  plugin.register({ on(name: string) { hooks.push(name); }, registerTool(factory: (ctx: object) => { name: string; parameters: { properties: object } }) {
    const tool = factory(context); names.push(tool.name);
    assert.ok(!Object.keys(tool.parameters.properties).some(k => ["id", "handle", "chatUid", "sender", "account", "allowOverlap", "constraints"].includes(k)));
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
  assert.deepEqual(f.commands.find(c => c[2] === "update"), ["plow-gog", "calendar", "update", "primary", "hold-one",
    "--summary", "Lunch with Guest", "--from", offers[0]!.start, "--to", offers[0]!.end, "--account", "owner@example.com",
    "--send-updates", "all", "--json", "--with-meet", "--attendees", "guest@example.net"]);
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

test("a rejected Thursday counterproposal returns new times within the owner's saved conditions", async t => {
  const f = fixture(t);
  const result = await guestAction(context, "other_times", { days: ["thu"] });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.match(JSON.stringify(result), /requested preferences.*unavailable/);
  assert.ok(f.request().offered.length > 0);
  for (const offer of f.request().offered) {
    assert.ok(["2026-10-05", "2026-10-06"].includes(offer.start.slice(0, 10)));
    assert.ok(offer.start.slice(11, 16) >= "10:00" && offer.end.slice(11, 16) <= "15:00");
    assert.ok(!offers.some(old => old.start === offer.start || Date.parse(old.start) === Date.parse(offer.start)));
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

test("outside-hours request records approval without creating or booking anything", async t => {
  const f = fixture(t);
  const result = await f.act(context, "ask_owner", { start: "2026-10-05T20:00" });
  assert.ok(!("error" in result)); assert.equal(f.request().status, "offered");
  assert.deepEqual(f.request().pendingOwner, { start: "2026-10-05T20:00:00+00:00", end: "2026-10-05T20:30:00+00:00", askedAt: new Date(now).toISOString() });
  assert.ok(f.commands.every(c => c[2] === "events"));
  assert.match(f.ownerLines[0]!, /Guest in your Lunch group asks: .*outside your working hours/);
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

test("a second time approval cannot replace an open ask", async t => {
  const f = fixture(t);
  await f.act(context, "ask_owner", { start: "2026-10-05T20:00" });
  const pending = f.request().pendingOwner;
  const reads = f.commands.length;
  const result = await f.act(context, "ask_owner", { start: "2026-10-06T20:00" });
  assert.match(JSON.stringify(result), /already open/);
  assert.deepEqual(f.request().pendingOwner, pending);
  assert.equal(f.commands.length, reads);
  assert.equal(f.ownerLines.length, 1);
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

test("a booked meeting can have a general question without changing the booking", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.status = "booked"; f.save(f.ledger);
  const result = await f.tools.get("meetly_ask_owner")!.execute("ask", { question: "Which entrance?" });
  assert.doesNotMatch(result.content[0]!.text, /error/);
  assert.equal(f.request().status, "booked");
  assert.deepEqual(f.commands, []);
  assert.equal(f.deliveries.length, 1);
});

test("format before and after booking updates the event and records only the backend Meet link", async t => {
  const f = fixture(t);
  await guestAction(context, "format", { format: "in_person", location: "Library" });
  assert.deepEqual(f.commands, []); assert.equal(f.request().location, "Library");
  await guestAction(context, "pick", { start: offers[0]!.start });
  f.commands.length = 0;
  const result = await guestAction(context, "format", { format: "meet" });
  assert.equal(f.request().format, "meet"); assert.equal(f.request().meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(f.commands, [["plow-gog", "calendar", "update", "primary", "hold-one", "--account", "owner@example.com", "--send-updates", "all", "--json", "--with-meet"]]);
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
    const result = await f.act(context, action, { start: offers[0]!.start });
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
    f.ledger.requests.push({ ...f.ledger.requests[0]!, id: "closed", status: "booked", chatUid: context.nativeChannelId });
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
  assert.ok("error" in result); assert.deepEqual(f.read(), f.ledger);
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


test("replacement times can overlap the request's old holds without overriding a conflict", async t => {
  const f = fixture(t);
  f.ledger.requests[0]!.durationMin = 60;
  f.ledger.requests[0]!.offered = offers.map(o => ({ ...o, end: o.end.replace("10:30", "11:00") }));
  for (const e of f.events.values()) e.end.dateTime = e.end.dateTime.replace("10:30", "11:00");
  f.save(f.ledger);
  const result = await guestAction(context, "other_times", { after: "10:30", before: "11:30" });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(f.request().offered.length, 2);
  assert.ok(f.request().offered.every(o => o.start.slice(11, 16) === "10:30"));
  assert.ok(f.commands.every(c => !c.includes("--confirm-conflict")));
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
