import { test } from "node:test";
import assert from "node:assert/strict";
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

// A card saved without its country code reads in the Mac's region (#51): with or
// without that region's trunk prefix, and never as a partial, another country's
// number, or in an unknown region.
for (const [locale, number, handle, names] of [
  ["en_US", "555.123.4567", "+15551234567", ["Ana"]],
  ["en_US", "(555) 123-4567", "+15551234567", ["Ana"]],
  ["en_US", "1-555-123-4567", "+15551234567", ["Ana"]],
  ["en_GB", "07700 900123", "+447700900123", ["Ana"]],
  ["it_IT", "06 1234 5678", "+390612345678", ["Ana"]],
  ["en_US@rg=gbzzzz", "07700 900123", "+447700900123", ["Ana"]],
  ["en_IS", "555 1234", "+3545551234", ["Ana"]],
  ["en_US", "123-4567", "+15551234567", []],
  ["en_US", "7700 900123", "+447700900123", []],
  [undefined, "555.123.4567", "+15551234567", []],
  ["en", "555.123.4567", "+15551234567", []],
  ["en_US", "555.123.4567 ext 2", "+15551234567", []],
] as const) test(`national number ${number} in ${locale ?? "no region"} → ${names.length ? "match" : "no match"}`, () => {
  const out = `${locale === undefined ? "" : `L|${locale}\n`}S|0\nR|4|Ana||\nP|4|${number}\n`;
  assert.deepEqual(parseContacts(out, handle).map(p => p.name), names);
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
  assert.deepEqual(await lookupContact(" +55 (47) 99254-7532 ", { token: "tok", fetch: bridge("S|0\nR|7|Ana|Souza|\nP|7|+55 (47) 99254-7532\n") }),
    { found: true, handle: "+5547992547532", name: "Ana Souza", phones: ["+55 (47) 99254-7532"], emails: [], matches: 1 });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", fetch: bridge("S|0\nR|7|Local|Number|\nP|7|47992547532\nE|7|wrong@example.com\n") }),
    { found: false, handle: "+5547992547532" });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", fetch: bridge("S|0\n") }), { found: false, handle: "+5547992547532" });
  assert.deepEqual(await lookupContact(" A@B ", { token: "tok", fetch: bridge("S|0\nR|7|Ana|Souza|\nE|7|a@b\n") }),
    { found: true, handle: "a@b", name: "Ana Souza", phones: [], emails: ["a@b"], matches: 1 });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "" }), { found: false, handle: "+5547992547532", reason: "mac-unavailable" });
});
