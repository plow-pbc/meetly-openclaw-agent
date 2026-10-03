---
name: meetly
description: Reference for Meetly's scripts (state, calendar math, cron, Plow calls). Read it when a meetly-* skill names a script.
---
# Meetly scripts

Run each as `node /opt/plow/skills/meetly/scripts/<name>.ts` with `exec`.
Success prints one JSON line. Failure prints `error: <message>` on stderr and
exits non-zero: report that line; never guess a result. State lives in
`/var/lib/plow/meetly/`.

| Script | Arguments | Prints |
|---|---|---|
| `setup-status.ts` | | `{status:"READY", config, range:{from,to}}` or `{status:"SETUP_NEEDED", next, question, draft}` |
| `record-setup.ts` | `--field F --value V` \| `--done` | before setup `{saved, next, question}`; after `{saved, config}`; `--done` → `{done, config, crons}` |
| `register-crons.ts` | `[--pause \| --resume]` | `{paused, actions}` |
| `cursor.ts` | `get` \| `set <rowid>` \| `hold <rowid>` \| `release` \| `fail` \| `ok` | the cursor `{rowid, held?, …}`; `set` stops below `held` until the ledger has a request with that `sourceRowid`; `fail` → `{failingSince, warn}` |
| `ledger.ts` | `find --handle H [--status asked\|offered]` \| `find --chat U` | `{request}` or `{request:null}` |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer by handle or inbound `sourceRowid`, re-keying it to the supplied handle and preserving its id, chat link and delivery state; `status:"asked"` changes nothing if one is open) |
| | `update --id X --json '<patch>'` | `{request}`; patch keys: `status, chatUid, eventId, offered, holdCleanup, name, location, allowOverlap, constraints, topic, pendingOwner, format, locale, booked, meetUrl, reminder` (`null` clears `pendingOwner`, `booked`, `meetUrl`, `reminder`) |
| | `expired [--hours N]` \| `asked [--unnotified]` \| `pending` \| `cleanup` | `{requests}` (`--unnotified` selects asked requests without `notifiedAt`) |
| | `delivery --id X --kind notify\|start --action begin\|complete\|clear` | `{request}`; `begin` records `notifyAttemptedAt`/`startedAt`; `complete` records `notifiedAt`/`startCompletedAt` after success or unknown delivery. Notices retry until completed; starts refuse a second attempt. `clear` is only for an unlinked start, on the owner's explicit instruction. Delivery fields cannot be set through `save` or `update`. |
| | `reminders [--lead-min N]` | `{requests}`: booked Meets whose link is due (default 10 min before, until 5 min after the start) |
| `event.ts` | `--in F` | `{id, status, start, end, meetUrl}` from a saved calendar event read |
| `calendar.ts` | `offer --json '<request with slots, no hold ids>'` | `{request}`: create holds and atomically replace the offer; retains the old offer on failure |
| | `book --id X --json '{"start":"<ISO>","end":"<ISO for a non-offered time>","attendees":"<email if known>"}'` | `{request, meetUrl, warning?:"no-meet-link"}`: book and release the other holds |
| | `format --id X --json '{"format":"meet", "location":"<optional place>"}'` | update and record a booked event |
| | `pending` | `{ids}`: requests with a durable write awaiting reconciliation |
| | `drop\|expire\|cancel\|cleanup\|resume --id X` | `{request, skipped?}`: close an offer, cancel a booked event, retry cleanup, or reconcile an unresolved write |
| `reminder-check.ts` | `--id X --event-file F [--lead-min N]` | `{action:"send"\|"wait"\|"cancelled"\|"no-link"\|"skip", send?:{chatUid, meetUrl, name, locale, time, minutesToStart}}` |
| | `--id X --sent` | `{request}`: the reminder went out; refused if already handled |
| `busy.ts` | `--fetch` (reads the Mac, writes `tmp/busy.json`) | `{file, busy:<count>, degraded, unknownAfter?}` |
| | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `slots.ts` | `--in busy.json [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--allow-overlap ID]… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], unknownAfter?, degraded}` |
| | `--in busy.json --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--duration N] [--allow-overlap ID]… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `contact.ts` | `--handle <+E164 or email>` | `{found:true, handle, name, phones, emails, matches}`, `{found:false, handle}` or `{found:false, handle, reason:"mac-unavailable"}` |

Notes:
- A request's `format` is `meet`, `in_person`, `phone` or `unknown`.
  `meetUrl` only ever holds `https://meet.google.com/xxx-xxxx-xxx`, only on
  a `meet`; the ledger refuses anything else.
- Every calendar mutation goes through `calendar.ts`. It locks the request,
  persists each write's identity, and commits the ledger from the actual result.
  An unresolved write must be resumed, never replayed or bypassed. Reminders
  read the event from a saved calendar read; never copy an id, time or link by hand.
- `slots.ts` only offers times inside the owner's days and window. Requests
  only narrow them.
- Use each slot's `label` and `dayOfWeek` as printed; never work out a
  weekday yourself. Pass `--locale` for whoever reads the message (the other
  person's locale, like `pt-BR` or `en-US`, from their language or their
  phone's country code).
