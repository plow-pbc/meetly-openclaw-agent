import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { MacCommand } from "../skills/meetly/scripts/mac.ts";

const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "meetly", "scripts");

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "meetly-"));
}

export type CliResult = { status: number | null; stdout: string; stderr: string; json: any };

export function cli(script: string, args: string[], env: Record<string, string>, input?: string): CliResult {
  const proc = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
  let json: unknown;
  try {
    json = proc.stdout.trim() ? JSON.parse(proc.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, json };
}

export type CalendarEvent = { id: string; summary?: string; status: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: { email: string; organizer?: boolean; self?: boolean }[]; hangoutLink?: string; location?: string; extendedProperties?: { private: { meetlyOperation: string } } };
export const calendarEvent = (id: string, start: string, end: string): CalendarEvent => ({ id, summary: "PRIVATE CALENDAR TITLE", status: "confirmed", start: { dateTime: start }, end: { dateTime: end } });

export function fakeCalendar(initial: CalendarEvent[]) {
  const events = new Map(initial.map(event => [event.id, event]));
  const calls: string[][] = [];
  let nextId = 0;
  const command = async ({ argv }: Pick<MacCommand, "argv">) => {
    assert.deepEqual(argv.slice(0, 2), ["plow-gog", "calendar"]);
    calls.push(argv);
    const flag = (name: string) => argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
    switch (argv[2]) {
      case "events": {
        const from = Date.parse(flag("--from")!), to = Date.parse(flag("--to")!);
        const token = flag("--private-prop-filter")?.split("=")[1];
        return { output: JSON.stringify({ events: [...events.values()].filter(e =>
          (!token || e.extendedProperties?.private.meetlyOperation === token)
          && (!flag("--from") || Date.parse(e.end.dateTime) > from) && (!flag("--to") || Date.parse(e.start.dateTime) < to)) }) };
      }
      case "event": return { output: JSON.stringify({ event: events.get(argv[4]!) }) };
      case "delete": {
        const event = events.get(argv[4]!); if (event) event.status = "cancelled";
        return { output: "deleted" };
      }
      case "create": case "update": {
        if (argv[2] === "create" && !argv.includes("--confirm-conflict") && [...events.values()].some(e =>
          e.status !== "cancelled" && Date.parse(e.start.dateTime) < Date.parse(flag("--to")!) && Date.parse(e.end.dateTime) > Date.parse(flag("--from")!))) {
          return { error: "PRIVATE BACKEND ERROR owner@example.com" };
        }
        const id = argv[2] === "create" ? `new-${++nextId}` : argv[4]!;
        const event = events.get(id) ?? calendarEvent(id, flag("--from")!, flag("--to")!);
        if (flag("--from") !== undefined) event.start.dateTime = flag("--from")!;
        if (flag("--to") !== undefined) event.end.dateTime = flag("--to")!;
        if (argv.includes("--with-meet")) event.hangoutLink = "https://meet.google.com/abc-defg-hij";
        if (flag("--location") !== undefined) event.location = flag("--location");
        if (flag("--add-attendee") !== undefined) event.attendees = [...(event.attendees ?? []), ...flag("--add-attendee")!.split(",").map(email => ({ email }))];
        if (flag("--attendees") !== undefined) event.attendees = flag("--attendees")!.split(",").map(email => ({ email }));
        if (flag("--private-prop")) event.extendedProperties = { private: { meetlyOperation: flag("--private-prop")!.split("=")[1]! } };
        event.status = "confirmed"; events.set(id, event);
        return { output: JSON.stringify({ event }) };
      }
      default: throw new Error(`unexpected command ${JSON.stringify(argv)}`);
    }
  };
  return { events, calls, command };
}
