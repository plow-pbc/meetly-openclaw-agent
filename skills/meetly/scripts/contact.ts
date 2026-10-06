// Who wrote from a handle, per the owner's Contacts on the Mac: the card's
// name, phones and emails, read-only across every AddressBook store (the root
// one and one per sync source), in one Mac call. Never a note or an address.
// A handle with no card is not an error: the request goes on with the handle.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { normalizeHandle, sameHandle } from "./ledger.ts";
import { fetchIdentity, findOwnerDm, plowApi, type ApiOptions } from "./owner-chat.ts";

export type Person = { name: string | null; phones: string[]; emails: string[] };
export type Lookup =
  | { found: true; handle: string; name: string | null; phones: string[]; emails: string[]; matches: number }
  | { found: false; handle: string; reason?: "mac-unavailable" | "bridge-token-missing" };

export type ContactOptions = BridgeOptions & { api?: ApiOptions };

const STRIPPED = "replace(replace(replace(replace(replace(replace(replace(p.ZFULLNUMBER, char(160), ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')";

// Lines `R|id|first|last|org`, `P|id|number`, `E|id|email` for candidate cards;
// suffix SQL only narrows the search, parseContacts requires canonical equality.
export function contactQuery(handle: string): string {
  handle = normalizeHandle(handle);
  const phone = handle.startsWith("+") ? handle.slice(1).slice(-8) : "";
  const email = phone ? "" : handle.replaceAll("'", "''");
  const match = phone
    ? `select p.ZOWNER from ZABCDPHONENUMBER p where ${STRIPPED} like '%${phone}'`
    : `select e.ZOWNER from ZABCDEMAILADDRESS e where lower(e.ZADDRESS) = '${email}'`;
  return `with m as (${match}) ` +
    "select 'R', r.Z_PK, coalesce(r.ZFIRSTNAME, ''), coalesce(r.ZLASTNAME, ''), coalesce(r.ZORGANIZATION, '') from ZABCDRECORD r where r.Z_PK in m " +
    "union all select 'P', p.ZOWNER, p.ZFULLNUMBER, '', '' from ZABCDPHONENUMBER p where p.ZOWNER in m " +
    "union all select 'E', e.ZOWNER, e.ZADDRESS, '', '' from ZABCDEMAILADDRESS e where e.ZOWNER in m;";
}

async function ownerRegion(opts: ApiOptions = {}): Promise<CountryCode | undefined> {
  const dm = findOwnerDm(await fetchIdentity(plowApi(opts)));
  const phone = dm?.participants?.find(p => p.type === "member" && p.role === "owner")?.provider_key;
  if (!phone?.startsWith("+")) return undefined;
  return parsePhoneNumberFromString(phone, { extract: false })?.country;
}

function samePhone(value: string, handle: string, defaultCountry?: CountryCode): boolean {
  // Do not extract a number from text or collapse an extension into its main line.
  if (!/^[+\d\s().-]+$/.test(value)) return false;
  const phone = parsePhoneNumberFromString(value, { defaultCountry, extract: false });
  if (!phone?.isPossible() || phone.number !== handle) return false;
  if (value.trim().startsWith("+")) {
    // An international number must keep every digit, except an explicit optional trunk zero.
    const international = value.replace(new RegExp(`^(\\s*\\+${phone.countryCallingCode}\\s*)\\(0\\)`), "$1");
    if (international.replace(/[\s().-]/g, "") !== handle) return false;
  }
  return true;
}

// The cards in the output (`S|n` starts store n) that really carry the handle.
export function parseContacts(output: string, handle: string, defaultCountry?: CountryCode): Person[] {
  handle = normalizeHandle(handle);
  const cards = new Map<string, Person>();
  let store = "";
  for (const line of output.split("\n")) {
    const [kind, id = "", a = "", b = "", c = ""] = line.trim().split("|");
    if (kind === "S") store = id;
    const key = `${store}:${id}`;
    if (kind === "R") cards.set(key, { name: [a, b].filter(Boolean).join(" ") || c || null, phones: [], emails: [] });
    if (kind === "P") cards.get(key)?.phones.push(a);
    if (kind === "E") cards.get(key)?.emails.push(a);
  }
  return [...cards.values()].filter((p) =>
    handle.startsWith("+")
      ? p.phones.some(value => samePhone(value, handle, defaultCountry))
      : p.emails.some(value => sameHandle(value, handle)));
}

export async function lookupContact(handle: string, opts: ContactOptions = {}): Promise<Lookup> {
  handle = normalizeHandle(handle);
  if (!(opts.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN)) return { found: false, handle, reason: "bridge-token-missing" };
  const query = contactQuery(handle);
  const output = await runOnMac({
    argv: ["/bin/sh", "-c",
      'i=0; /usr/bin/find "$HOME/Library/Application Support/AddressBook" -maxdepth 4 -name "AddressBook*.abcddb" | ' +
      'while IFS= read -r db; do echo "S|$i"; i=$((i+1)); /usr/bin/sqlite3 -readonly -separator "|" "$db" "$1" 2>/dev/null; done',
      "sh", query],
    readPaths: ["~/Library/Application Support/AddressBook"],
    goal: "Meetly: find the contact who asked to meet, by the number or email they wrote from (name, phones and emails only)",
    timeoutMs: 30_000,
  }, opts).catch(() => undefined);
  if (output === undefined) return { found: false, handle, reason: "mac-unavailable" };
  const region = handle.startsWith("+") ? await ownerRegion(opts.api).catch(() => undefined) : undefined;
  const people = parseContacts(output, handle, region);
  const first = people[0];
  if (!first) return { found: false, handle };
  return { found: true, handle, name: first.name, phones: first.phones, emails: first.emails, matches: people.length };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({ options: { handle: { type: "string" } } });
    if (!values.handle) throw new Error("usage: contact.ts --handle <+E164 or email>");
    return lookupContact(values.handle);
  });
}
