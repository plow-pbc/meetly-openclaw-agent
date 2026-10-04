import { test } from "node:test";
import assert from "node:assert/strict";
import { findOwnerChat, ownerChat, ownerDisplayName, type Identity } from "../skills/meetly/scripts/owner-chat.ts";

const self = { type: "agent", relationship: "self", line: { uid: "line_me" } };
const owner = { type: "member", role: "owner" };
const chat = (uid: string, participants: unknown[], status = "active") => ({ uid, status, participants });
const identity = (chats: unknown[]) => ({ line: { uid: "line_me" }, chats }) as Identity;

test("the one active two-person chat with the owner", () => {
  assert.equal(findOwnerChat(identity([chat("dm", [self, owner])])), "dm");
});

test("inactive, group and other-line chats are ignored", () => {
  const other = { type: "agent", relationship: "self", line: { uid: "line_other" } };
  const chats = [
    chat("old", [self, owner], "archived"),
    chat("group", [self, owner, { type: "member", role: "guest" }]),
    chat("elsewhere", [other, owner]),
    chat("stranger", [self, { type: "member", role: "guest" }]),
  ];
  assert.equal(findOwnerChat(identity(chats)), null);
  assert.equal(findOwnerChat(identity([...chats, chat("dm", [owner, self])])), "dm");
});

test("two owner DMs is an error; none is null", () => {
  assert.throws(() => findOwnerChat(identity([chat("a", [self, owner]), chat("b", [self, owner])])), /expected one owner's chat; found 2/);
  assert.equal(findOwnerChat({}), null);
});

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("ownerChat asks /v1/agents/me with the token and no redirects", async () => {
  const calls: Call[] = [];
  const out = await ownerChat({ fetch: fakeFetch(200, identity([chat("dm", [self, owner])]), calls), base: "https://api.plow.test/", token: "tok" });
  assert.deepEqual(out, { chatUid: "dm" });
  assert.equal(calls[0]!.url, "https://api.plow.test/v1/agents/me");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.ok(calls[0]!.init?.signal);
});

test("ownerChat fails loudly", async () => {
  const base = "https://api.plow.test";
  await assert.rejects(ownerChat({ fetch: fakeFetch(200, identity([])), base, token: "t" }), /the owner has not texted this line yet/);
  await assert.rejects(ownerChat({ fetch: fakeFetch(500, {}), base, token: "t" }), /HTTP 500/);
  await assert.rejects(ownerChat({ fetch: fakeFetch(200, identity([])), base: "", token: "t" }), /PLOW_API_BASE/);
  await assert.rejects(ownerChat({ fetch: fakeFetch(200, identity([])), base, token: "" }), /PLOW_AGENT_TOKEN/);
});

test("ownerDisplayName reads the owner's profile name from their DM", async () => {
  const named = { ...owner, display_name: " Jean Jacintho " };
  const opts = (body: unknown) => ({ fetch: fakeFetch(200, body), base: "https://api.plow.test", token: "tok" });
  assert.equal(await ownerDisplayName(opts(identity([chat("dm", [self, named])]))), "Jean Jacintho");
  assert.equal(await ownerDisplayName(opts(identity([chat("dm", [self, owner])]))), undefined);
  assert.equal(await ownerDisplayName(opts(identity([]))), undefined);
});


test("phone-number profile fallbacks are not owner names", async () => {
  for (const display_name of ["+15557654321", "(555) 765-4321", "555.765.4321", "  +44 20 7946 0123  "]) {
    const body = identity([chat("dm", [self, { ...owner, display_name }])]);
    assert.equal(await ownerDisplayName({ fetch: fakeFetch(200, body), base: "https://api.plow.test", token: "tok" }), undefined);
  }
});
