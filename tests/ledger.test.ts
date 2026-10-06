import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRequest, saveRequest, cleanupList, pendingOwnerList, expiredRequests, findByChat, findOpenByHandle, normalizeHandle, sameHandle, updateRequest,
  type Ledger, type NewRequest, type Patch,
} from "../skills/meetly/scripts/ledger.ts";
import { DEFAULTS } from "../skills/meetly/scripts/config.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 3600_000;
const offer = { start: "2026-09-29T12:00:00-03:00", end: "2026-09-29T12:30:00-03:00", holdId: "h1", account: "jean@example.com" };
const input = (over: Record<string, unknown> = {}) => ({
  origin: "inbound", handle: "+15551234567", topic: "coffee", durationMin: 30, offered: [offer], ...over,
}) as NewRequest;
const empty = (): Ledger => ({ requests: [] });
const patchFixture = (home: string, id: string, patch: Patch) => {
  const path = join(home, "ledger.json");
  writeJson(path, updateRequest(readJson<Ledger>(path, empty()), id, patch, T0));
};

test("handles normalize phones and emails", () => {
  assert.equal(normalizeHandle("+1 (555) 123-4567"), "+15551234567");
  for (const handle of ['(555) 123-4567', '5551234567', '+05551234567', '+15551234567junk', '+1234567890123456', 'guest@', 'guest name@example.com', '']) {
    assert.throws(() => normalizeHandle(handle), /handle/);
  }
  assert.equal(normalizeHandle(" Ana@Example.COM "), "ana@example.com");
  assert.ok(sameHandle("+1 (555) 123-4567", "+15551234567"));
  assert.ok(!sameHandle("+15551234567", "(555) 123-4567"));
  assert.ok(sameHandle("ANA@example.com", "ana@EXAMPLE.com"));
  assert.ok(!sameHandle("+15551234567", "+15551234568"));
  assert.ok(!sameHandle("4567", "+15551234567"));
  assert.ok(!sameHandle("ana@example.com", "+15551234567"));
});

test("the same person written three ways matches one request", () => {
  const l = addRequest(empty(), input({ handle: "+1 (555) 123-4567" }), T0, "r_1");
  for (const h of ["+15551234567", "+1 5551234567", "+1 (555) 123-4567"]) assert.equal(findOpenByHandle(l, h)?.id, "r_1");
  const e = addRequest(empty(), input({ handle: "Ana@Example.com" }), T0, "r_2");
  assert.equal(findOpenByHandle(e, "ana@example.com")?.id, "r_2");
});

test("add sets status and times, and validates", () => {
  const l = addRequest(empty(), input(), T0, "r_1");
  const r = l.requests[0]!;
  assert.equal(r.status, "offered");
  assert.equal(r.offeredAt, new Date(T0).toISOString());
  assert.equal(r.createdAt, r.updatedAt);
  assert.throws(() => addRequest(empty(), input({ origin: "email" }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ handle: "" }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ topic: " " }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ durationMin: 0 }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [] }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [{ ...offer, start: "soon" }] }), T0, "x"));
  assert.throws(() => addRequest(empty(), input({ offered: [{ ...offer, account: "" }] }), T0, "x"));
});

test("a second open request for the same person is refused until the first closes", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  assert.throws(() => addRequest(l, input({ handle: "+1 (555) 123-4567", origin: "owner" }), T0, "r_2"), /open request r_1 already exists/);
  l = updateRequest(l, "r_1", { status: "booked", eventId: "e1" }, T0);
  l = addRequest(l, input(), T0, "r_2");
  assert.equal(findOpenByHandle(l, "+15551234567")?.id, "r_2");
});

test("save replaces a duplicate open offer by normalized handle and preserves its id and chat link", () => {
  const original = addRequest(empty(), input({ chatUid: "chat_1" }), T0, "r_1");
  const updatedOffer = { ...offer, start: "2026-09-30T12:00:00-03:00", holdId: "h2" };
  const saved = saveRequest(original, input({ handle: "+1 (555) 123-4567", offered: [updatedOffer] }), T0 + HOUR, "r_2");
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0]!.id, "r_1");
  assert.equal(saved.requests[0]!.chatUid, "chat_1");
  assert.deepEqual(saved.requests[0]!.offered, [updatedOffer]);
  assert.deepEqual(saved.requests[0]!.holdCleanup, [{ holdId: "h1", account: offer.account }]);
  assert.equal(saved.requests[0]!.offeredAt, new Date(T0 + HOUR).toISOString());
  assert.equal(findOpenByHandle(saved, "+15551234567")!.id, "r_1");
});

test("find by chat and sender resolves a replacement offer without a chat link", () => {
  let l = addRequest(empty(), input({ chatUid: "c1" }), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "dropped" }, T0 + HOUR);
  const nextOffer = { ...offer, start: "2026-09-29T12:30:00-03:00", end: "2026-09-29T13:00:00-03:00", holdId: "h2" };
  l = addRequest(l, input({ handle: "+1 (555) 123-4567", offered: [nextOffer] }), T0 + 2 * HOUR, "r_2");

  // The unqualified chat lookup sees closed A; sender-aware lookup must pick B.
  assert.equal(findByChat(l, "c1")?.id, "r_1");
  assert.equal(findByChat(l, "c1", "+15551234567")?.id, "r_2");
  assert.equal(findOpenByHandle(l, "+15551234567")?.id, "r_2");
  assert.equal(findByChat(l, "c1", "+15551234567")?.offered[0]?.holdId, "h2");
  assert.equal(findByChat(l, "c2"), undefined);
});

test("CLI sender-aware chat lookup prefers open request over closed chat history", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c1" }))], env);
  const old = cli("ledger.ts", ["find", "--chat", "c1"], env).json.request;
  patchFixture(home, old.id, { status: "dropped" });
  const replacement = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h2" }] }))], env).json.request;
  const current = cli("ledger.ts", ["find", "--chat", "c1", "--handle", "+15551234567"], env);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.json.request.id, replacement.id);
});

test("CLI combined lookup returns a closed chat request when the sender has no open request", () => {
  for (const status of ["booked", "dropped", "expired"] as const) {
    const home = tmpHome();
    const env = { MEETLY_HOME: home };
    const created = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c1" }))], env);
    const request = created.json.request;
    patchFixture(home, request.id, { status });

    const result = cli("ledger.ts", ["find", "--chat", "c1", "--handle", "+15551234567"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.request.id, request.id);
    assert.equal(result.json.request.status, status);
  }
});

test("sender-aware chat lookup does not hide an open request linked to another chat", () => {
  let l = addRequest(empty(), input({ chatUid: "c1" }), T0, "r_closed");
  l = updateRequest(l, "r_closed", { status: "dropped" }, T0 + HOUR);
  l = addRequest(l, input({ chatUid: "c2", offered: [{ ...offer, holdId: "h2" }] }), T0 + 2 * HOUR, "r_open");

  const chatResult = findByChat(l, "c1", "+15551234567");
  const handleResult = findOpenByHandle(l, "+15551234567");
  assert.equal(chatResult?.id, "r_closed");
  assert.equal(handleResult?.id, "r_open");
  assert.notEqual(chatResult?.id, handleResult?.id);
  assert.equal(handleResult?.chatUid, "c2");
});

test("update resets offeredAt with new offers and rejects unknown keys", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = updateRequest(l, "r_1", { chatUid: "c1" }, T0 + HOUR);
  assert.equal(l.requests[0]!.offeredAt, new Date(T0).toISOString());
  assert.equal(l.requests[0]!.updatedAt, new Date(T0 + HOUR).toISOString());
  l = updateRequest(l, "r_1", { offered: [{ ...offer, holdId: "h9" }] }, T0 + 2 * HOUR);
  assert.equal(l.requests[0]!.offeredAt, new Date(T0 + 2 * HOUR).toISOString());
  assert.throws(() => updateRequest(l, "r_1", { handle: "x" } as never, T0), /unknown key/);
  assert.throws(() => updateRequest(l, "r_1", { status: "lost" } as never, T0), /status/);
  assert.throws(() => updateRequest(l, "nope", { status: "dropped" }, T0), /no request/);
});

test("expired: 48 hours after the offer, open requests only", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = addRequest(l, input({ handle: "+15559999999" }), T0, "r_2");
  l = updateRequest(l, "r_2", { status: "booked" }, T0);
  assert.deepEqual(expiredRequests(l, 48, T0 + 47 * HOUR), []);
  assert.deepEqual(expiredRequests(l, 48, T0 + 48 * HOUR).map((r) => r.id), ["r_1"]);
});

const asked = (over: Record<string, unknown> = {}) => input({ status: "asked", offered: undefined, sourceRowid: 42, locale: "pt-BR", ...over });

test("save as asked records the request with no offer, holds or chat", () => {
  const l = saveRequest(empty(), asked(), T0, "r_1");
  const r = l.requests[0]!;
  assert.deepEqual([r.status, r.offered, r.sourceRowid, r.locale, r.offeredAt, r.chatUid], ["asked", [], 42, "pt-BR", undefined, undefined]);
  assert.throws(() => saveRequest(empty(), asked({ offered: [offer] }), T0, "x"), /no offered times or chat/);
  assert.throws(() => saveRequest(empty(), asked({ chatUid: "c1" }), T0, "x"), /no offered times or chat/);
  assert.throws(() => saveRequest(empty(), input({ status: "booked" }), T0, "x"), /asked or offered/);
});

test("find by handle returns an asked request; asking again changes nothing; no chat resolves to it", () => {
  const l = saveRequest(empty(), asked(), T0, "r_1");
  assert.equal(findOpenByHandle(l, "+1 (555) 123-4567")?.id, "r_1");
  assert.equal(saveRequest(l, asked({ handle: "+15551234567", topic: "lunch" }), T0 + HOUR, "r_2"), l);
  assert.equal(findByChat(l, "c1", "+15551234567"), undefined);
});

test("asked becomes offered by saving the offer over it, keeping the request", () => {
  let l = saveRequest(empty(), asked({ handle: "ana@example.com" }), T0, "r_1");
  l = saveRequest(l, input({ handle: "ana@example.com" }), T0 + HOUR, "r_2");
  const r = l.requests[0]!;
  assert.equal(l.requests.length, 1);
  assert.deepEqual([r.id, r.status, r.handle, r.sourceRowid, r.locale], ["r_1", "offered", "ana@example.com", 42, "pt-BR"]);
  assert.deepEqual(r.offered, [offer]);
  assert.deepEqual(r.holdCleanup, []);
  assert.equal(r.offeredAt, new Date(T0 + HOUR).toISOString());
});

test("CLI re-keys an inbound email request by source row so a phone reply finds the same offer", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(asked({ handle: "ana@example.com" }))], env).json.request;
  writeJson(join(env.MEETLY_HOME, "config.json"), { ...DEFAULTS, ownerName: "Owner", timezone: "UTC",
    defaultAccount: offer.account, calendars: [{ account: offer.account, id: offer.account }], setupDoneAt: new Date(T0).toISOString() });
  const batch = cli("pipeline.ts", ["nudge"], env).json;
  const offered = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ sourceRowid: 42 }))], env);
  assert.equal(offered.status, 0, offered.stderr);
  assert.equal(offered.json.request.id, saved.id);
  assert.equal(offered.json.request.lastNudge.fingerprint, batch.items[0].fingerprint);
  assert.deepEqual(cli("ledger.ts", ["asked"], env).json, { requests: [] });
  const reply = cli("ledger.ts", ["find", "--chat", "c_unknown", "--handle", "+15551234567"], env).json.request;
  assert.equal(reply.id, saved.id);
  assert.equal(reply.offered[0].holdId, "h1");
});

test("re-keying refuses a phone already used by another open request", () => {
  let l = saveRequest(empty(), asked({ handle: "ana@example.com" }), T0, "r_email");
  l = addRequest(l, input(), T0, "r_phone");
  assert.throws(() => saveRequest(l, input({ sourceRowid: 42 }), T0, "unused"), /another open request/);
  assert.equal(l.requests.length, 2);
});


test("CLI blocks a second group start across re-offers until its marker is cleared", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const { id } = cli("ledger.ts", ["save", "--json", JSON.stringify(asked())], env).json.request;
  const delivery = (action: string) => cli("ledger.ts", ["delivery", "--id", id, "--kind", "start", "--action", action], env);
  assert.equal(delivery("begin").status, 1);
  cli("ledger.ts", ["save", "--json", JSON.stringify(input())], env);
  assert.equal(delivery("complete").status, 1);
  const attempt = delivery("begin");
  assert.equal(attempt.status, 0, attempt.stderr);
  assert.ok(attempt.json.request.startedAt);
  assert.equal(delivery("begin").status, 1);
  assert.ok(delivery("complete").json.request.startCompletedAt);
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h2" }] }))], env);
  assert.equal(saved.json.request.startedAt, attempt.json.request.startedAt);
  assert.equal(cli("ledger.ts", ["save", "--json", JSON.stringify(input({ startedAt: null }))], env).status, 1);
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json", '{"startedAt":null}'], env).status, 1);
  assert.match(delivery("begin").stderr, /already attempted/);
  const cleared = delivery("clear");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(cleared.json.request.startedAt, undefined);
  assert.equal(cleared.json.request.startCompletedAt, undefined);
  assert.equal(delivery("begin").status, 0);
  cli("ledger.ts", ["update", "--id", id, "--json", '{"chatUid":"c1"}'], env);
  assert.equal(delivery("clear").status, 1);
  assert.equal(delivery("begin").status, 1);
});

test("the owner's conditions from the yes survive a later offer; the person's proposed times are kept apart", () => {
  const proposed = { days: ["fri"] };
  const owner = { after: "14:00" };
  let l = saveRequest(empty(), asked({ proposed }), T0, "r_1");
  l = saveRequest(l, input({ proposed, constraints: owner }), T0 + HOUR, "r_2");
  // A counterproposal re-offers with the same owner conditions, or none passed at all.
  l = saveRequest(l, input({ offered: [{ ...offer, holdId: "h2" }], constraints: owner }), T0 + 2 * HOUR, "r_3");
  l = saveRequest(l, input({ offered: [{ ...offer, holdId: "h3" }] }), T0 + 3 * HOUR, "r_4");
  const r = l.requests[0]!;
  assert.deepEqual([l.requests.length, r.id, r.origin, r.constraints, r.proposed], [1, "r_1", "inbound", owner, proposed]);
});

test("asked becomes dropped when the owner says no", () => {
  let l = saveRequest(empty(), asked(), T0, "r_1");
  l = updateRequest(l, "r_1", { status: "dropped" }, T0 + HOUR);
  assert.equal(l.requests[0]!.status, "dropped");
  assert.equal(findOpenByHandle(l, "+15551234567"), undefined);
});

test("an asked request expires 48 hours after it was saved, with no holds to delete", () => {
  const l = saveRequest(empty(), asked(), T0, "r_1");
  assert.deepEqual(expiredRequests(l, 48, T0 + 47 * HOUR), []);
  const [expired] = expiredRequests(l, 48, T0 + 48 * HOUR);
  assert.deepEqual([expired?.id, expired?.offered, cleanupList(l)], ["r_1", [], []]);
});

test("CLI saves an asked request, finds it by handle but never by chat", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(asked())], env);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.json.request.status, "asked");
  assert.equal(cli("ledger.ts", ["find", "--handle", "+1 (555) 123-4567"], env).json.request.id, saved.json.request.id);
  assert.deepEqual(cli("ledger.ts", ["find", "--chat", "c1", "--handle", "+15551234567"], env).json, { request: null });
  const again = cli("ledger.ts", ["save", "--json", JSON.stringify(asked({ topic: "lunch" }))], env);
  assert.deepEqual([again.json.request.id, again.json.request.topic], [saved.json.request.id, "coffee"]);
});

test("a guest replying in an older group can neither find nor link their asked request", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const old = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "c_old" }))], env).json.request;
  patchFixture(env.MEETLY_HOME, old.id, { status: "booked" });
  const { id } = cli("ledger.ts", ["save", "--json", JSON.stringify(asked())], env).json.request;

  assert.equal(cli("ledger.ts", ["find", "--chat", "c_old", "--handle", "+15551234567"], env).json.request.id, old.id);
  assert.deepEqual(cli("ledger.ts", ["find", "--handle", "+15551234567", "--status", "offered"], env).json, { request: null });
  const link = cli("ledger.ts", ["update", "--id", id, "--json", '{"chatUid":"c_old"}'], env);
  assert.equal(link.status, 1);
  assert.match(link.stderr, /no chat until the owner says yes/);
  assert.equal(cli("ledger.ts", ["find", "--handle", "+15551234567"], env).json.request.status, "asked");
});

test("cleanup lists only requests with pending hold deletes", () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  l = addRequest(l, input({ handle: "+15559999999" }), T0, "r_2");
  l = updateRequest(l, "r_2", { holdCleanup: [{ holdId: "h7", account: "jean@example.com" }], status: "expired" }, T0);
  l = updateRequest(l, "r_1", { holdCleanup: [] }, T0);
  assert.deepEqual(cleanupList(l).map((r) => r.id), ["r_2"]);
});

for (const [kind, fields, invalid, bookedCount] of [
  ["time approval", { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T10:30:00-03:00" }, [{ start: "sat" }], 1],
  ["question", { question: "Which project?" }, [
    { question: " " }, { question: "x".repeat(501) }, { askedAt: "yesterday" }, { start: new Date(T0).toISOString() },
  ], 1],
] as const) test(`pendingOwner ${kind} is set, validated, listed and cleared`, () => {
  let l = addRequest(empty(), input(), T0, "r_1");
  const pending = { ...fields, askedAt: new Date(T0).toISOString() };
  l = updateRequest(l, "r_1", { pendingOwner: pending }, T0);
  assert.deepEqual(pendingOwnerList(l).map(r => r.pendingOwner), [pending]);
  for (const patch of invalid) assert.throws(() => updateRequest(l, "r_1", { pendingOwner: { ...pending, ...patch } }, T0), /pendingOwner/);
  l = updateRequest(l, "r_1", { status: "booked" }, T0);
  assert.equal(pendingOwnerList(l).length, bookedCount);
  for (const status of ["dropped", "expired"] as const) {
    assert.deepEqual(pendingOwnerList(updateRequest(l, "r_1", { status }, T0)), []);
  }
  l = updateRequest(l, "r_1", { pendingOwner: null }, T0);
  assert.equal("pendingOwner" in l.requests[0]!, false);
  assert.deepEqual(pendingOwnerList(l), []);
});

test("CLI add, find, update, expired and cleanup round-trip", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const added = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ handle: "+1 (555) 123-4567" }))], env);
  assert.equal(added.status, 0, added.stderr);
  const id = added.json.request.id;
  assert.match(id, /^r_[0-9a-f]{8}$/);
  assert.equal(cli("ledger.ts", ["find", "--handle", "+1 (555) 123-4567"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["find", "--handle", "+15550000000"], env).json, { request: null });
  const patch = join(home, "patch.json");
  writeFileSync(patch, JSON.stringify({ chatUid: "chat_1" }));
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json-file", patch], env).json.request.chatUid, "chat_1");
  assert.equal(cli("ledger.ts", ["find", "--chat", "chat_1"], env).json.request.id, id);
  assert.deepEqual(cli("ledger.ts", ["expired"], env).json, { requests: [] });
  assert.equal(cli("ledger.ts", ["expired", "--hours", "0"], env).json.requests.length, 1);
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [] });
  patchFixture(home, id, { holdCleanup: [{ holdId: "h1", account: "a" }] });
  assert.deepEqual(cli("ledger.ts", ["cleanup"], env).json, { requests: [{ id, holdCleanup: [{ holdId: "h1", account: "a" }] }] });
  const pend = { start: "2026-10-03T10:00:00-03:00", end: "2026-10-03T10:30:00-03:00", askedAt: "2026-09-28T12:00:00Z" };
  cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify({ pendingOwner: pend })], env);
  assert.deepEqual(cli("ledger.ts", ["pending"], env).json.requests.map((r: { id: string }) => r.id), [id]);
  const dup = cli("ledger.ts", ["add", "--json", JSON.stringify(input())], env);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);
  const saved = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ offered: [{ ...offer, holdId: "h2" }] }))], env);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.json.request.id, id);
  assert.equal(saved.json.request.chatUid, "chat_1");
  assert.equal(saved.json.request.offered[0].holdId, "h2");
  assert.deepEqual(saved.json.request.holdCleanup, [
    { holdId: "h1", account: "a" },
    { holdId: "h1", account: offer.account },
  ]);
});

test("a corrupt ledger.json fails loudly", () => {
  const home = tmpHome();
  writeFileSync(join(home, "ledger.json"), "[oops");
  const r = cli("ledger.ts", ["find", "--handle", "+15551234567"], { MEETLY_HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ledger\.json/);
});


test("public ledger updates cannot bypass calendar or reminder commits", () => {
  const home = tmpHome(), env = { MEETLY_HOME: home };
  const saved = cli("ledger.ts", ["add", "--json", JSON.stringify(input())], env).json.request;
  for (const [key, value] of Object.entries({ status: "booked", eventId: "other", offered: [offer], holdCleanup: [],
    booked: { start: offer.start, end: offer.end, account: offer.account }, meetUrl: null, reminder: null, calendarRevision: "other",
    format: "meet", location: "Library" })) {
    const result = cli("ledger.ts", ["update", "--id", saved.id, "--json", JSON.stringify({ [key]: value })], env);
    assert.equal(result.status, 1, key);
    assert.match(result.stderr, /managed by/);
  }
  assert.deepEqual(cli("ledger.ts", ["find", "--handle", saved.handle], env).json.request, saved);
});

for (const save of [addRequest, saveRequest]) test(`${save.name} persists only canonical phone or email handles`, () => {
  for (const [handle, expected] of [[' +1 (555) 123-4567 ', '+15551234567'], [' Guest@Example.COM ', 'guest@example.com']]) {
    assert.equal(save(empty(), input({ handle }), T0, 'canonical').requests[0]!.handle, expected);
  }
});

test('saving a canonical suffix collision creates a separate request without replacing the original', () => {
  const original = addRequest(empty(), input(), T0, 'r_1');
  const saved = saveRequest(original, input({ handle: '+115551234567' }), T0, 'r_2');
  assert.equal(saved.requests.length, 2);
  assert.deepEqual(saved.requests[0], original.requests[0]);
});

test("CLI lists and clears a general owner question using the existing pending command", () => {
  const home = tmpHome();
  const env = { MEETLY_HOME: home };
  const id = cli("ledger.ts", ["add", "--json", JSON.stringify(input({ chatUid: "chat_1" }))], env).json.request.id;
  const pendingOwner = { question: "Which project?", askedAt: new Date(T0).toISOString() };
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json", JSON.stringify({ pendingOwner })], env).status, 0);
  const pending = cli("ledger.ts", ["pending"], env).json.requests;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].chatUid, "chat_1");
  assert.deepEqual(pending[0].pendingOwner, pendingOwner);
  assert.equal(cli("ledger.ts", ["update", "--id", id, "--json", '{"pendingOwner":null}'], env).status, 0);
  assert.deepEqual(cli("ledger.ts", ["pending"], env).json.requests, []);
});


for (const origin of ["owner", "owner-group", "inbound"] as const) test(`requests preserve their chat and prompt policy across re-offers (${origin})`, () => {
  const ledger = addRequest(empty(), input({ origin, chatUid: "cht_MiXeD", askDetails: false }), T0, "r_1");
  assert.throws(() => saveRequest(ledger, input({ chatUid: "cht_mixed" }), T0 + HOUR, "r_2"), /cannot move/);
  assert.throws(() => updateRequest(ledger, "r_1", { chatUid: "elsewhere" }, T0 + HOUR), /cannot move/);
  const saved = saveRequest(ledger, input(), T0 + HOUR, "r_2").requests[0]!;
  assert.equal(saved.origin, origin);
  assert.equal(saved.askDetails, false);
  assert.equal(saved.chatUid, "cht_MiXeD");
});

test("a fresh start reservation tells the caller to send, and a duplicate explicitly forbids sending", () => {
  const env = { MEETLY_HOME: tmpHome() };
  const { id } = cli("ledger.ts", ["save", "--json", JSON.stringify(input())], env).json.request;
  const delivery = (action: string) => cli("ledger.ts", ["delivery", "--id", id, "--kind", "start", "--action", action], env);
  const begin = delivery("begin");
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(begin.json.delivery.sendNow, true);
  assert.equal(begin.json.delivery.state, "reserved");
  assert.match(begin.json.delivery.instruction, /Send the opener now/);
  assert.match(begin.json.delivery.instruction, /Do not begin or clear again/);
  const duplicate = delivery("begin");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Do not send/);
  const complete = delivery("complete");
  assert.equal(complete.json.delivery.sendNow, false);
  assert.equal(complete.json.delivery.state, "completed");
  const cleared = delivery("clear");
  assert.equal(cleared.json.delivery.sendNow, false);
  assert.equal(cleared.json.delivery.state, "cleared");
  assert.equal(delivery("begin").json.delivery.sendNow, true);
  const fresh = cli("ledger.ts", ["save", "--json", JSON.stringify(input({ handle: "+15550108502" }))], env).json.request;
  assert.notEqual(fresh.id, id);
  assert.equal(fresh.startedAt, undefined);
  const next = cli("ledger.ts", ["delivery", "--id", fresh.id, "--kind", "start", "--action", "begin"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.json.delivery.sendNow, true);
});

test("DM name lookup finds only an unambiguous open request", () => {
  const home = tmpHome();
  const ledger = addRequest(empty(), input({ name: "Bo", origin: "owner-group", chatUid: "bo-chat" }), T0, "bo");
  ledger.requests.push({ ...ledger.requests[0]!, id: "closed", status: "booked" });
  writeJson(join(home, "ledger.json"), ledger);
  const find = (name: string) => cli("ledger.ts", ["find", "--name", name], { MEETLY_HOME: home });
  assert.equal(find(" BO ").json?.request?.id, "bo");
  assert.deepEqual(find("Boris").json, { request: null });
  ledger.requests.push({ ...ledger.requests[0]!, id: "other", handle: "+15557654321" });
  writeJson(join(home, "ledger.json"), ledger);
  const ambiguous = find("Bo");
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous/i);
});

test("inbound meal classification applies code defaults and preserves explicit lengths", () => {
  for (const [meal, explicit, expected] of [
    ["lunch", undefined, 60], ["dinner", undefined, 60], ["coffee", undefined, 30],
    [undefined, undefined, 45], ["lunch", 90, 90], ["dinner", 30, 30],
  ] as const) {
    const home = tmpHome();
    writeJson(join(home, "config.json"), { ...DEFAULTS, durationMin: 45, ownerName: "Alex", timezone: "UTC", defaultAccount: "owner@example.com", calendars: [{ account: "owner@example.com", id: "primary" }], setupDoneAt: new Date(T0).toISOString() });
    const result = cli("ledger.ts", ["save", "--json", JSON.stringify({
      origin: "inbound", status: "asked", handle: "+15551234567", topic: "Catch up", meal,
      ...(explicit === undefined ? {} : { durationMin: explicit }), sourceRowid: 1,
    })], { MEETLY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.request.durationMin, expected);
    assert.equal(result.json.request.meal, meal);
  }
});
