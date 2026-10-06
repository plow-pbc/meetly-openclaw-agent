import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { contactQuery, lookupContact, parseContacts } from "../skills/meetly/scripts/contact.ts";

test("contact queries accept canonical ledger handles", () => {
  for (const h of ["a@b", "+5511999990000", " +55 (11) 99999-0000 ", "ana@example.com"]) assert.doesNotThrow(() => contactQuery(h), h);
  for (const h of ["11 99999-0000", "ana", "x' or 1=1 --@a.b"]) assert.throws(() => contactQuery(h), /E\.164/, h);
});

test("the query filters on the handle's last four digits and never reads notes or addresses", () => {
  const q = contactQuery("+5547992547532");
  assert.match(q, /like '%7532'/);
  // A complete national number shorter than eight digits (Iceland's 555 1234) stays a candidate.
  const suffix = /like '%(\d+)'/.exec(contactQuery("+3545551234"))![1]!;
  assert.ok("5551234".endsWith(suffix), suffix);
  assert.doesNotMatch(q, /ZNOTE|ZABCDPOSTALADDRESS/);
  assert.match(contactQuery(" Ana@Example.com "), /lower\(e\.ZADDRESS\) = 'ana@example\.com'/);
  assert.match(contactQuery("o'brien@example.com"), /lower\(e\.ZADDRESS\) = 'o''brien@example\.com'/);
});

test("phone candidates match only the full canonical handle across stores", () => {
  const out = [
    "S|0",
    "R|7|Local|Number|",
    "P|7|(47) 99254-7532",
    "E|7|wrong@example.com",
    "S|1",
    "R|7|Ana|Souza|",
    "P|7|+55 (47) 99254-7532",
    "P|7|+55 11 3333-0000",
    "E|7|ana@example.com",
    "R|8|Other|Person|",
    "P|8|+1 (650) 992-5475 32",
    "R|9|Longer|Number|",
    "P|9|+15547992547532",
    "R|10|Invalid|Number|",
    "P|10|+5547992547532junk",
  ].join("\n");
  const people = parseContacts(out, " +55 (47) 99254-7532 ");
  assert.deepEqual(people, [{ name: "Ana Souza", phones: ["+55 (47) 99254-7532", "+55 11 3333-0000"], emails: ["ana@example.com"] }]);
});

test("organization stands in for a card without a person's name", () => {
  const people = parseContacts("S|0\nR|3|||Acme\nE|3|Hi@Acme.com\n", " HI@ACME.COM ");
  assert.equal(people[0]!.name, "Acme");
});

function bridge(output: string | undefined): typeof fetch {
  return (async () => {
    const out = output === undefined ? { exit_code: 1, output: "" } : { exit_code: 0, output };
    const result = { content: [{ type: "text", text: JSON.stringify(out) }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`);
  }) as typeof fetch;
}

test("lookupContact says found, not found, or no Mac, and never throws for a missing card", async () => {
  assert.deepEqual(await lookupContact(" +55 (47) 99254-7532 ", { token: "tok", api: ownerApi(undefined), fetch: bridge("S|0\nR|7|Ana|Souza|\nP|7|+55 (47) 99254-7532\n") }),
    { found: true, handle: "+5547992547532", name: "Ana Souza", phones: ["+55 (47) 99254-7532"], emails: [], matches: 1 });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", api: ownerApi(undefined), fetch: bridge("S|0\nR|7|Local|Number|\nP|7|47992547532\nE|7|wrong@example.com\n") }),
    { found: false, handle: "+5547992547532" });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", api: ownerApi(undefined), fetch: bridge("S|0\n") }), { found: false, handle: "+5547992547532" });
  assert.deepEqual(await lookupContact(" A@B ", { token: "tok", api: ownerApi(undefined), fetch: bridge("S|0\nR|7|Ana|Souza|\nE|7|a@b\n") }),
    { found: true, handle: "a@b", name: "Ana Souza", phones: [], emails: ["a@b"], matches: 1 });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "" }), { found: false, handle: "+5547992547532", reason: "bridge-token-missing" });
});

const card = (phone: string) => `S|0\nR|4|Ana|Lee|\nP|4|${phone}\nE|4|ana@example.com\n`;

for (const [phone, handle, region] of [
  ["555.123.4567", "+15551234567", "US"],
  ["1-555-123-4567", "+15551234567", "US"],
  ["07700 900123", "+447700900123", "GB"],
  ["06 1234 5678", "+390612345678", "IT"],
  ["555 1234", "+3545551234", "IS"],
  ["138 0013 8000", "+8613800138000", "CN"],
  ["915.555.0188", "+19155550188", "US"],
  ["(917) 555-0112", "+19175550112", "US"],
  ["020 7946 0958", "+442079460958", "GB"],
  ["0044 20 7946 0958", "+442079460958", "GB"],
  ["011 44 20 7946 0958", "+442079460958", "US"],
  ["+44 (0)20 7946 0958", "+442079460958", "US"],
  ["(47) 99254-7532", "+5547992547532", "BR"],
  ["(416) 555-0100", "+14165550100", "CA"],
  ["(650)\u00a0555-0100", "+16505550100", "US"],
] as const) test(`card ${phone} matches E.164 in the owner's ${region} region`, () => {
  assert.equal(parseContacts(card(phone), handle, region)[0]?.name, "Ana Lee");
});

for (const [phone, handle, region] of [
  ["123-4567", "+15551234567", "US"],
  ["51234567", "+15551234567", "US"],
  ["+445551234567", "+15551234567", "US"],
  ["+115551234567", "+15551234567", "US"],
  ["+15551234567junk", "+15551234567", "US"],
  ["+16505550100 ext. 2", "+16505550100", "US"],
  ["020 7946 0958", "+442079460958", "US"],
  ["7700 900123", "+447700900123", "US"],
  ["(650) 555-0100", "+16505550100", "GB"],
  ["0044 20 7946 0958", "+442079460958", "US"],
] as const) test(`card ${phone} cannot match ${handle} in ${region}`, () => {
  assert.deepEqual(parseContacts(card(phone), handle, region), []);
});

test("national cards fail closed without an owner region; international cards still match", () => {
  assert.deepEqual(parseContacts(`L|en_US\n${card("650.555.0100")}`, "+16505550100"), []);
  assert.equal(parseContacts(`L|en_GB\n${card("650.555.0100")}`, "+16505550100", "US")[0]?.name, "Ana Lee");
  assert.equal(parseContacts(card("+1 (650) 555-0100"), "+16505550100")[0]?.name, "Ana Lee");
});

function ownerApi(phone: string | undefined) {
  return { base: "https://api.plow.test", token: "agent-token", fetch: (async (url, init) => {
    assert.equal(String(url), "https://api.plow.test/v1/agents/me");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer agent-token");
    assert.equal(init?.redirect, "error");
    return Response.json({ line: { uid: "self" }, chats: [{ uid: "owner-dm", status: "active", participants: [
      { type: "agent", relationship: "self", line: { uid: "self" } },
      { type: "member", role: "owner", provider_key: phone },
    ] }] });
  }) as typeof fetch };
}

for (const [owner, phone, handle] of [
  ["+16505550100", "555.123.4567", "+15551234567"],
  ["+442079460100", "020 7946 0958", "+442079460958"],
  ["+14165550100", "(416) 555-0101", "+14165550101"],
] as const) test(`lookup derives the card region from owner ${owner}`, async () => {
  const result = await lookupContact(handle, { token: "bridge-token", fetch: bridge(card(phone)), api: ownerApi(owner) });
  assert.equal(result.found, true);
  assert.equal("name" in result && result.name, "Ana Lee");
});

for (const owner of [undefined, "+15557654321", "6505550100", "a@b"]) test(`lookup does not infer a region from guest when owner is ${owner}`, async () => {
  const result = await lookupContact("+16505550100", { token: "bridge-token", fetch: bridge(card("650.555.0100")), api: ownerApi(owner) });
  assert.deepEqual(result, { found: false, handle: "+16505550100" });
});

test("a missing bridge token reports its cause without calling either service", async () => {
  const noFetch = (async () => { assert.fail("no service should be called"); }) as typeof fetch;
  assert.deepEqual(await lookupContact("+16505550100", { token: "", fetch: noFetch, api: { ...ownerApi("+16505550100"), fetch: noFetch } }),
    { found: false, handle: "+16505550100", reason: "bridge-token-missing" });
});

test("a failed Mac call still reports mac-unavailable when the token exists", async () => {
  assert.deepEqual(await lookupContact("+16505550100", { token: "tok", fetch: bridge(undefined), api: ownerApi(undefined) }),
    { found: false, handle: "+16505550100", reason: "mac-unavailable" });
});

test("an owner identity outage never guesses national numbers but preserves international matches", async () => {
  const api = { ...ownerApi(undefined), fetch: (async () => new Response("", { status: 503 })) as typeof fetch };
  assert.deepEqual(await lookupContact("+16505550100", { token: "tok", fetch: bridge(card("650.555.0100")), api }),
    { found: false, handle: "+16505550100" });
  const international = await lookupContact("+16505550100", { token: "tok", fetch: bridge(card("+1 (650) 555-0100")), api });
  assert.equal(international.found, true);
});

test("lookupContact strips nonbreaking spaces before SQL candidate selection", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
    INSERT INTO ZABCDRECORD VALUES (4, 'Ana', 'Lee', '');
    INSERT INTO ZABCDEMAILADDRESS VALUES (4, 'ana@example.com');
  `);
  const phone = "(650)\u00a0555-01\u00a000";
  db.prepare("INSERT INTO ZABCDPHONENUMBER VALUES (4, ?)").run(phone);
  const fetchSql = (async (url, init) => {
    const call = JSON.parse(String(init?.body));
    const query = db.prepare(call.params.arguments.argv.at(-1));
    query.setReturnArrays(true);
    const output = "S|0\n" + query.all().map(row => Object.values(row).join("|")).join("\n");
    return bridge(output)(url, init);
  }) as typeof fetch;
  assert.deepEqual(await lookupContact("+16505550100", { token: "tok", fetch: fetchSql, api: ownerApi("+16505550101") }),
    { found: true, handle: "+16505550100", name: "Ana Lee", phones: [phone], emails: ["ana@example.com"], matches: 1 });
});
