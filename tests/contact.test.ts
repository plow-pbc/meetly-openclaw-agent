import { test } from "node:test";
import assert from "node:assert/strict";
import { contactQuery, isHandle, lookupContact, parseContacts } from "../skills/meetly/scripts/contact.ts";

test("a handle is a phone in E.164 or an email", () => {
  for (const h of ["+5511999990000", "ana@example.com"]) assert.equal(isHandle(h), true, h);
  for (const h of ["11 99999-0000", "ana", "a@b", "x' or 1=1 --@a.b"]) assert.equal(isHandle(h), false, h);
});

test("the query filters on the handle's last eight digits and never reads notes or addresses", () => {
  const q = contactQuery("+5547992547532");
  assert.match(q, /like '%92547532'/);
  assert.doesNotMatch(q, /ZNOTE|ZABCDPOSTALADDRESS/);
  assert.match(contactQuery("Ana@Example.com"), /lower\(e\.ZADDRESS\) = 'ana@example\.com'/);
  assert.throws(() => contactQuery("ana"), /E\.164.*or an email/);
});

test("a card matches a phone handle when one number is a suffix of the other", () => {
  const out = [
    "S|0",
    "S|1",
    "R|7|Ana|Souza|",
    "P|7|(47) 99254-7532",
    "P|7|+55 11 3333-0000",
    "E|7|ana@example.com",
    "R|8|Other|Person|",
    "P|8|+1 (650) 992-5475 32",
  ].join("\n");
  const people = parseContacts(out, "+5547992547532");
  assert.deepEqual(people, [{ name: "Ana Souza", phones: ["(47) 99254-7532", "+55 11 3333-0000"], emails: ["ana@example.com"] }]);
});

test("organization stands in for a card without a person's name", () => {
  const people = parseContacts("S|0\nR|3|||Acme\nE|3|hi@acme.com\n", "hi@acme.com");
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
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", fetch: bridge("S|0\nR|7|Ana|Souza|\nP|7|47992547532\n") }),
    { found: true, handle: "+5547992547532", name: "Ana Souza", phones: ["47992547532"], emails: [], matches: 1 });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "tok", fetch: bridge("S|0\n") }), { found: false, handle: "+5547992547532" });
  assert.deepEqual(await lookupContact("+5547992547532", { token: "" }), { found: false, handle: "+5547992547532", reason: "mac-unavailable" });
});
