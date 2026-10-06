// Offline integration: real base channel, policy pipeline and email tool;
// scripted model choices, with Plow and calendar responses confined to fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerRequest } from "../skills/meetly/scripts/calendar.ts";
import { answerOwner } from "../skills/meetly/scripts/answer-owner.ts";
import { emailStart } from "../skills/meetly/scripts/email.ts";
import { recordDelivery, type Ledger } from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { registerGuestTools } from "../plugin/guest-tools.js";

const load = (path: string) => import(path);
const require = createRequire("/opt/plow/plugin/package.json");
const { WebSocketServer } = require("ws");
const { default: base } = await load("/opt/plow/plugin/index.ts");
const { renderConfig } = await load("/opt/plow/boot/config.ts");
const { probeIdentity } = await load("/opt/plow/boot/probe-fixture.ts");
const { t: buildContext } = await load("/app/dist/context-BigCXBTA.mjs");
const { t: resolveProfile } = await load("/app/dist/conversation-capability-profile-EUPtpcbI.mjs");
const { i: resolvePolicies, t: buildSteps } = await load("/app/dist/conversation-tool-policy-pipeline-lj6t0cRI.mjs");
const { t: applyPipeline } = await load("/app/dist/tool-policy-pipeline-BjUxseTY.mjs");
const { resolveStorePath, updateLastRoute } = await load(require.resolve("openclaw/plugin-sdk/session-store-runtime"));
const guestNames = ["meetly_view_request", "meetly_pick_time", "meetly_other_times", "meetly_set_format", "meetly_ask_owner", "meetly_decline"];
const now = Date.parse("2026-10-03T08:00:00Z");
const reports: object[] = [];

for (const mode of ["sent", "unknown", "failed", "transport-unknown"]) test(`email outreach through the base channel; opener=${mode}`, async t => {
  const unknown = mode === "unknown" || mode === "transport-unknown";
  const home = mkdtempSync(join(tmpdir(), "meetly-email-flow-"));
  // The host's session workers may still be flushing after the turn completes.
  process.once("exit", () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const previous = { ...process.env };
  Object.assign(process.env, { OPENCLAW_STATE_DIR: home, MEETLY_HOME: home, PLOW_AGENT_TOKEN: "fixture", PLOW_MCP_BRIDGE_TOKEN: "fixture", PLOW_GUEST_TOOLS: guestNames.join(",") });
  t.mock.method(Date, "now", () => now);
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    for (const key of ["OPENCLAW_STATE_DIR", "MEETLY_HOME", "PLOW_AGENT_TOKEN", "PLOW_MCP_BRIDGE_TOKEN", "PLOW_GUEST_TOOLS"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const cfg = renderConfig(probeIdentity, apiBase);
  Object.assign(cfg.channels.plow, { lineUid: "phone", emailLineUid: "mail", emailName: "Meetly", guestTools: guestNames });
  cfg.plugins.load.paths = ["/opt/plow/plugin"];
  const config = { ...DEFAULTS, ownerName: "Alex", timezone: "UTC", defaultAccount: "alex@example.com",
    calendars: [{ account: "alex@example.com", id: "primary" }], setupDoneAt: new Date(now).toISOString() };
  writeJson(join(home, "config.json"), config);
  const ledgerPath = join(home, "ledger.json");
  const ledger = () => readJson<Ledger>(ledgerPath, { requests: [] });
  const request = () => ledger().requests[0]!;
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Alex", provider_key: "alex@example.com" };
  const ana = { type: "member", uid: "ana", role: "member", display_name: "Ana", provider_key: "ana@example.net" };
  const ea = { type: "member", uid: "ea", role: "member", display_name: "Ana's assistant", provider_key: "ea@example.net" };
  const self = (uid: string) => ({ type: "agent", relationship: "self", line: { uid } });
  const chats: Record<string, any> = {
    home: { uid: "home", status: "active", trusted: false, participants: [self("phone"), owner] },
    instruction: { uid: "instruction", status: "active", trusted: false, display_name: "Email Ana", participants: [self("mail"), owner] },
    meeting: { uid: "meeting", status: "active", trusted: false, display_name: "Coffee with Alex", participants: [self("mail"), owner, ana, ea] },
  };
  const events = new Map<string, any>();
  const commands: string[][] = [];
  const messages: { thread: string; from: string; body: string }[] = [{ thread: "instruction", from: "Alex", body: "Email Ana about coffee next week on Google Meet." }];
  const posts: { path: string; body: any }[] = [];
  let nextEvent = 0;
  t.mock.method(globalThis, "fetch", async (url: any, init: RequestInit = {}) => {
    if (String(url).includes("/mcp")) {
      const call = JSON.parse(String(init.body));
      const argv: string[] = call.params.arguments.argv;
      commands.push(argv);
      assert.deepEqual(argv.slice(0, 2), ["plow-gog", "calendar"]);
      const flag = (name: string) => argv[argv.indexOf(name) + 1]!;
      let output: any;
      switch (argv[2]) {
        case "events": output = { events: [...events.values()].filter(e => Date.parse(e.start.dateTime) < Date.parse(flag("--to")) && Date.parse(e.end.dateTime) > Date.parse(flag("--from"))) }; break;
        case "event": output = { event: events.get(argv[4]!) }; break;
        case "delete": events.get(argv[4]!)!.status = "cancelled"; output = "deleted"; break;
        case "create": case "update": {
          const id = argv[2] === "create" ? `event-${++nextEvent}` : argv[4]!;
          const event = { ...events.get(id), id, status: "confirmed", summary: flag("--summary"), start: { dateTime: flag("--from") }, end: { dateTime: flag("--to") },
            extendedProperties: { private: { meetlyOperation: flag("--private-prop").split("=")[1] } },
            ...(argv.includes("--attendees") ? { attendees: flag("--attendees").split(",").map(email => ({ email })) } : {}),
            ...(argv.includes("--with-meet") ? { hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}) };
          events.set(id, event); output = { event }; break;
        }
        default: throw new Error(`unexpected calendar operation: ${argv}`);
      }
      return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(output) }) }] } });
    }
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    if (init.method === "POST" && path !== "/ws/ticket" && !path.endsWith("/typing")) {
      const body = JSON.parse(String(init.body)); posts.push({ path, body });
      if (path === "/chats") {
        assert.ok(request().startedAt, "reserve the opener before sending");
        assert.equal(request().offered.length, 3);
        assert.ok(request().offered.every(o => o.holdId));
        assert.equal([...events.values()].filter(event => event.status !== "cancelled").length, 3);
        assert.deepEqual(body.members, [ana.provider_key]);
        if (mode === "failed") return Response.json({ error: "fixture refusal" }, { status: 400 });
        if (mode === "transport-unknown") throw new TypeError("fixture lost receipt");
        messages.push({ thread: "meeting", from: "Meetly", body: body.body });
        return Response.json({ status: unknown ? "unknown" : "sent", chat_uid: unknown ? null : "meeting" });
      }
      messages.push({ thread: path.split("/")[2]!, from: "Meetly", body: body.body });
      return Response.json({ uid: `message-${posts.length}` });
    }
    if (path === "/chats") return Response.json({ data: Object.values(chats), has_more: false });
    if (path.endsWith("/messages")) return Response.json({ data: [], has_more: false });
    return Response.json(chats[path.split("/")[2]!] ?? { ticket: "fixture" });
  });
  const factories: any[] = [];
  let channel: any, incoming: any, turn: (dispatch: any) => Promise<void>;
  const runtime = { channel: {
    routing: { resolveAgentRoute: ({ accountId, peer }: any) => ({ agentId: "main", sessionKey: peer.id === "plow-owner" ? "agent:main:main" : `agent:main:plow:${accountId}:${peer.kind}:${peer.id}` }) },
    session: { resolveStorePath, updateLastRoute },
    inbound: { buildContext: async (value: any) => { incoming = value; return buildContext(value); }, dispatch: async (dispatch: any) => {
      await turn(dispatch); dispatch.replyOptions.onAgentRunTerminalOutcome("completed");
      return { dispatched: true, dispatchResult: {} };
    } },
  } };
  base.register({ registrationMode: "full", logger: { info() {} }, runtime, on() {}, registerChannel(value: any) { channel = value.plugin; }, registerTool(factory: any) { factories.push(factory); } });
  registerGuestTools({ runtime, registerTool(factory: any) { factories.push(factory); } }, undefined, async () => {
    const outbound = await load(require.resolve("openclaw/plugin-sdk/channel-outbound"));
    return { ...outbound, sendDurableMessageBatch: async (args: any) => {
      try { return await outbound.sendDurableMessageBatch(args); }
      catch (error) { t.diagnostic(String(error)); throw error; }
    } };
  });
  const context = (chat: string, senderIsOwner: boolean) => ({ config: cfg, messageChannel: "plow", agentAccountId: "email",
    nativeChannelId: chat, requesterSenderId: senderIsOwner ? "plow-owner" : ea.provider_key, senderIsOwner,
    sessionKey: `agent:main:plow:email:direct:${chat}` });
  const tools = (ctx: any) => new Map(factories.map(factory => { const tool = factory(ctx); return [tool.name, tool]; }));
  const send = async (ctx: any, args: object, allowFailure = false) => {
    const result = await (tools(ctx).get("plow_send_email") as any).execute("email", args);
    if (!allowFailure) assert.ok(!result.isError, JSON.stringify(result)); return result.details ?? JSON.parse(result.content[0].text);
  };
  const offered = [5, 6, 7].map(day => ({ start: `2026-10-0${day}T10:00:00Z`, end: `2026-10-0${day}T10:30:00Z`, account: config.defaultAccount }));
  await offerRequest({ channel: "email", origin: "owner", handle: ana.provider_key, name: "Ana", topic: "coffee", meal: "coffee", durationMin: 30,
    constraints: { from: "2026-10-05", to: "2026-10-11" }, format: "meet", locale: "en-US", offered });
  await emailStart(request().id);
  const opened = await send(context("instruction", true), { to: [ana.provider_key], subject: "Coffee with Alex",
    body: "Hi Ana, I'm Meetly, Alex's scheduling assistant. Alex would like coffee over Google Meet next week. Alex is free Mon Oct 5, Tue Oct 6, or Wed Oct 7, each at 10:00 AM UTC for 30 minutes. Which works?" }, true);
  if (mode === "failed" || mode === "transport-unknown") assert.equal(opened.success, false);
  else assert.equal(opened.sent, unknown ? "unknown" : true);
  await emailStart(request().id, opened);
  if (mode === "failed") {
    assert.equal(request().status, "dropped");
    assert.equal([...events.values()].filter(event => event.status !== "cancelled").length, 0);
    reports.push({ mode, messages, status: request().status, holdsReleased: 3, assertions: "failed receipt drops request and releases holds" });
    if (process.env.MEETLY_EMAIL_REPORT) writeFileSync(process.env.MEETLY_EMAIL_REPORT, JSON.stringify({ scenarios: reports }, null, 2));
    return;
  }
  assert.throws(() => recordDelivery(ledger(), request().id, "start", "begin", now), /already attempted/);

  let frame = 0;
  async function receive(body: string, act: (dispatch: any, tools: Map<any, any>) => Promise<void>) {
    messages.push({ thread: "meeting", from: "Ana's assistant", body });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const onConnection = (socket: any) => socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${++frame}`, chat_id: "meeting",
      data: { message: { uid: `inbound-${frame}`, direction: "inbound", sender: ea, body, attachments: [], created_at: new Date(now + frame * 1000).toISOString() } } }));
    server.once("connection", onConnection);
    let dispatched = false;
    let dispatchError: unknown;
    turn = async dispatch => {
      dispatched = true;
      try {
        assert.equal(incoming.sender.id, ea.provider_key);
        const catalog = [...tools(context("meeting", false)).values(), { name: "exec" }, { name: "automations" }];
        const capabilityProfile = resolveProfile({ config: cfg, agentId: "main", sessionKey: dispatch.route.sessionKey, conversationToolPolicy: dispatch.ctxPayload.ConversationToolPolicy });
        const available = applyPipeline({ tools: catalog, toolMeta: (tool: any) => tool.name.startsWith("meetly_") ? { pluginId: "meetly" } : tool.name.startsWith("plow_") ? { pluginId: "plow" } : undefined,
          warn() {}, steps: buildSteps({ capabilityProfile, policies: resolvePolicies({ capabilityProfile }), includeRuntimeToolPolicy: true }) });
        assert.deepEqual(available.map((tool: any) => tool.name).sort(), ["plow_send_email", ...guestNames].sort());
        await act(dispatch, new Map(available.map((tool: any) => [tool.name, tool])));
      } catch (error) { dispatchError = error; } finally { controller.abort(); }
    };
    try { await channel.gateway.startAccount({ account: { ...cfg.channels.plow, accountId: "email" }, cfg, abortSignal: controller.signal, log: { info() {} } }); }
    finally { clearTimeout(timer); server.removeListener("connection", onConnection); }
    assert.ok(dispatched, "the base must dispatch the email turn");
    if (dispatchError) throw dispatchError;
  }
  if (unknown) {
    await receive("Tuesday at 10 works for Ana.", async (dispatch, available) => {
      for (const [name, args] of [["meetly_view_request", {}], ["meetly_pick_time", { start: offered[1]!.start }], ["meetly_decline", {}]] as const) {
        const result = (await available.get(name).execute("unlinked", args)).details;
        assert.ok(result.error, JSON.stringify(result));
      }
      assert.equal(request().chatUid, undefined);
      assert.equal(request().status, "offered");
      await dispatch.delivery.deliver({ text: "NO_REPLY" });
    });
    assert.equal(posts.filter(post => post.path === "/chats").length, 1);
    reports.push({ mode, unknownOpener: true, messages, status: request().status, linked: false, assertions: "unaffiliated thread refused; opener not repeated" });
    if (process.env.MEETLY_EMAIL_REPORT) writeFileSync(process.env.MEETLY_EMAIL_REPORT, JSON.stringify({ scenarios: reports }, null, 2));
    return;
  }
  await receive("Tuesday at 10 works for Ana.", async (dispatch, available) => {
    const viewed = (await available.get("meetly_view_request").execute("view", {})).details;
    assert.equal(viewed.chatUid, "meeting");
    const picked = (await available.get("meetly_pick_time").execute("pick", { start: offered[1]!.start })).details;
    assert.equal(picked.invitationSent, true);
    assert.equal(picked.status, "booked");
    assert.equal(picked.reminderAvailable, false);
    const result = await available.get("plow_send_email").execute("confirm", { to: "meeting",
      body: `Booked: Ana and Alex, Tue Oct 6 at 10:00 AM UTC, 30 minutes on Google Meet. Invitation sent. Join: ${picked.meetUrl}` });
    assert.ok(!result.isError);
    await dispatch.delivery.deliver({ text: "NO_REPLY" });
  });
  assert.equal(request().chatUid, "meeting");
  assert.equal(request().status, "booked");
  const booked = events.get(request().eventId!);
  assert.deepEqual(booked.attendees, [{ email: ana.provider_key }]);
  const invitation = commands.find(argv => argv.includes("--attendees"))!;
  assert.equal(invitation[invitation.indexOf("--send-updates") + 1], "all");
  assert.equal([...events.values()].filter(e => e.status !== "cancelled").length, 1);
  const beforeQuestion = posts.length;
  await receive("Should Ana bring the budget?", async (dispatch, available) => {
    const result = (await available.get("meetly_ask_owner").execute("question", { question: "Should Ana bring the budget?" })).details;
    assert.equal(result.ownerAskSent, true, JSON.stringify(result));
    assert.equal(result.silent, true);
    await dispatch.delivery.deliver({ text: "NO_REPLY" });
  });
  assert.deepEqual(posts.slice(beforeQuestion).map(post => post.path), ["/chats/home/messages"]);
  const ownerContext = { ...context("home", true), agentAccountId: "chat", sessionKey: "agent:main:main" };
  messages.push({ thread: "home", from: "Alex", body: "Yes, please tell Ana to bring the Q3 budget." });
  const answer = { outcome: "answer" as const, requestId: request().id, askedAt: request().pendingOwner!.askedAt, text: "Alex says, please bring the Q3 budget." };
  const planned = await answerOwner(ownerContext, answer, async () => assert.fail("no phone send"));
  assert.ok("email" in planned);
  await send(context("instruction", true), planned.email as object);
  await answerOwner(ownerContext, { ...answer, emailSent: true }, async () => assert.fail("no phone send"));
  assert.equal(request().pendingOwner, undefined);
  reports.push({ mode, unknownOpener: unknown, messages, booking: booked, holdsReleased: 2, guestTools: guestNames, status: request().status, assertions: "passed" });
  if (process.env.MEETLY_EMAIL_REPORT) writeFileSync(process.env.MEETLY_EMAIL_REPORT, JSON.stringify({ mode: "Offline fixtures; scripted model choices; real base dispatch, policy, email tool and calendar writer", scenarios: reports }, null, 2));
});
