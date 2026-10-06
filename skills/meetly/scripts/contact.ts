// Who wrote from a handle, per the owner's Contacts on the Mac: the card's
// name, phones and emails, read-only across every AddressBook store (the root
// one and one per sync source), in one Mac call. Never a note or an address.
// A handle with no card is not an error: the request goes on with the handle.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";
import { normalizeHandle, sameHandle } from "./ledger.ts";
import { CALLING_CODES } from "./calling-codes.ts";

export type Person = { name: string | null; phones: string[]; emails: string[] };
export type Lookup =
  | { found: true; handle: string; name: string | null; phones: string[]; emails: string[]; matches: number }
  | { found: false; handle: string; reason?: "mac-unavailable" };

const STRIPPED = "replace(replace(replace(replace(replace(replace(p.ZFULLNUMBER, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')";

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

// The Mac's region from its AppleLocale ("en_US", or "en_US@rg=gbzzzz" when the
// region is set apart from the language); undefined when it names none.
export function localeRegion(locale: string): string | undefined {
  const region = /@rg=([a-z]{2})/i.exec(locale)?.[1] ?? /^[a-z]{2,3}[_-]([a-z]{2})(?![a-z])/i.exec(locale)?.[1];
  return region?.toUpperCase();
}

// A card number saved without a country code is the owner's national number
// (#51), read the way Contacts reads it: in the Mac's region, with or without its
// trunk prefix. It matches only when that is exactly the handle -- a partial
// number, or one from another country, never does.
function nationalMatch(value: string, handle: string, region: string | undefined): boolean {
  const country = region ? CALLING_CODES[region] : undefined;
  const digits = value.replace(/[\s().-]/g, "");
  if (!country || !/^\d+$/.test(digits)) return false;
  const local = country.trunk && digits.startsWith(country.trunk) ? digits.slice(country.trunk.length) : digits;
  try {
    const target = normalizeHandle(handle);
    return [digits, local].some((n) => `+${country.code}${n}` === target);
  } catch { return false; }
}

// The cards in the output (`S|n` starts store n, `L|locale` names the Mac's
// region) that really carry the handle.
export function parseContacts(output: string, handle: string): Person[] {
  const cards = new Map<string, Person>();
  let store = "";
  let region: string | undefined;
  for (const line of output.split("\n")) {
    const [kind, id = "", a = "", b = "", c = ""] = line.trim().split("|");
    if (kind === "L") region = localeRegion(id);
    if (kind === "S") store = id;
    const key = `${store}:${id}`;
    if (kind === "R") cards.set(key, { name: [a, b].filter(Boolean).join(" ") || c || null, phones: [], emails: [] });
    if (kind === "P") cards.get(key)?.phones.push(a);
    if (kind === "E") cards.get(key)?.emails.push(a);
  }
  return [...cards.values()].filter((p) =>
    [...p.phones, ...p.emails].some((value) => sameHandle(value, handle) || nationalMatch(value, handle, region)));
}

export async function lookupContact(handle: string, opts: BridgeOptions = {}): Promise<Lookup> {
  handle = normalizeHandle(handle);
  const query = contactQuery(handle);
  const output = await runOnMac({
    argv: ["/bin/sh", "-c",
      'echo "L|$(/usr/bin/plutil -extract AppleLocale raw "$HOME/Library/Preferences/.GlobalPreferences.plist" 2>/dev/null)"; ' +
      'i=0; /usr/bin/find "$HOME/Library/Application Support/AddressBook" -maxdepth 4 -name "AddressBook*.abcddb" | ' +
      'while IFS= read -r db; do echo "S|$i"; i=$((i+1)); /usr/bin/sqlite3 -readonly -separator "|" "$db" "$1" 2>/dev/null; done',
      "sh", query],
    readPaths: ["~/Library/Application Support/AddressBook", "~/Library/Preferences/.GlobalPreferences.plist"],
    goal: "Meetly: find the contact who asked to meet, by the number or email they wrote from (name, phones and emails only, and the Mac's region for numbers saved without a country code)",
    timeoutMs: 30_000,
  }, opts).catch(() => undefined);
  if (output === undefined) return { found: false, handle, reason: "mac-unavailable" };
  const people = parseContacts(output, handle);
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
