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
| `request-view.ts` | `--id X` | Group-safe request view with `askDetails`; reserves any permitted format/place question before returning it. Ask format/place only when `askDetails` is true. |
| `ledger.ts` | `find --handle H [--status asked\|offered]` \| `find --chat U` \| `find --name N` | `{request}` with canonical `chatUid`; a name miss returns `{request:null, candidates:[open owner-group offers]}` for owner disambiguation |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer by handle or inbound `sourceRowid`, re-keying it to the supplied handle and preserving its id, chat link and delivery state; `status:"asked"` changes nothing if one is open) |
| | `update --id X --json '<patch>'` | `{request}`; patch keys: `chatUid, name, durationMin` (open requests only; re-offer after changing), `constraints, topic, pendingOwner, locale` (`null` clears `pendingOwner`); `allowOverlap`, format, location, calendar and reminder fields require their owning scripts; all ledger write commands reject `allowOverlap` |
| | `expired [--hours N]` \| `asked [--unnotified]` \| `pending` \| `cleanup` | `{requests}` (`--unnotified` selects asked requests without `notifiedAt`) |
| | `delivery --id X --kind notify\|start\|answer --action begin\|complete\|clear` | `{request, delivery?}`; `begin` records `notifyAttemptedAt`/`startedAt`; a successful start returns `delivery.state: reserved` and `sendNow: true` — send immediately once, without another begin, clear, or earlier-attempt check; `complete` records `notifiedAt`/`startCompletedAt` after success or unknown delivery. Notices retry until completed; starts refuse a second attempt. `answer begin` records `pendingOwner.answerAttemptedAt` before sending and refuses another attempt; successful answer delivery clears the pending question or time approval. `clear` is for an unlinked start or an answer attempt, on the owner's explicit instruction (answers use only `begin`/`clear`). Delivery fields cannot be set through `save` or `update`. |
| | `reminders [--lead-min N]` | `{requests}`: booked Meets whose link is due (default 10 min before, until 5 min after the start) |
| `event.ts` | `--in F` | `{id, status, start, end, meetUrl}` from a saved calendar event read |
| `calendar.ts` | `approve-time --id ID [--json '{"start":"ISO","attendees":"email"}']` | Books only if free; `TIME_APPROVAL_BUSY` returns `near` for `slots.ts --near ... --no-overlap`. Never grants overlap permission. |
| `calendar.ts` | `offer --json '<request with slots, no hold ids>'` | `{request}`: create holds and atomically replace the offer; retains an existing offer on failure; drops a failed new request while retaining cleanup |
| | `book --id X --json '{"start":"<ISO>","end":"<ISO for a non-offered time>","attendees":"<email if known>"}'` | `{request, meetUrl, warning?:"no-meet-link"}`: book and release the other holds |
| | `format --id X --json '{"format":"meet", "location":"<optional place>"}'` | save format/location on an offered request, or update and record a booked event; both use the calendar lock |
| | `resume-pending` | `{results:[{id, request?, error?}]}`: resume all pending writes, continuing past individual failures |
| | `pending` | `{ids}`: requests with a durable write awaiting reconciliation |
| | `drop\|expire\|cancel\|cleanup\|resume --id X` | `{request, skipped?}`: close an offer, cancel a booked event, retry cleanup, or reconcile an unresolved write |
| `reminder-check.ts` | `--id X --event-file F [--lead-min N]` | `{action:"send"\|"wait"\|"cancelled"\|"no-link"\|"skip", send?:{chatUid, meetUrl, name, locale, time, minutesToStart}}` |
| | `--id X --sent` | `{request}`: the reminder went out; refused if already handled |
| `busy.ts` | `--fetch [--allow-overlap-title <owner-supplied name>]` (reads the Mac, writes `tmp/busy.json`) | `{file, busy:<count>, degraded, unknownAfter?}` |
| | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `time.ts` | `next_week --anchor ISO --timezone IANA` | `{from,to}` in the owner's timezone, anchored to the source message timestamp; pass weekdays separately |
| `slots.ts` | `--in busy.json [--near <ISO or owner-zone wall time>] [--request ID] [--meal lunch\|dinner\|coffee] [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--allow-overlap '{"account":"…","id":"…"}']… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], durationMin, unknownAfter?, degraded}` |
| | `--in busy.json --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--meal lunch\|dinner\|coffee] [--duration N] [--allow-overlap '{"account":"…","id":"…"}']… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `contact.ts` | `--handle <+E164 or email>` | `{found:true, handle, name, phones, emails, matches}`, `{found:false, handle}` or `{found:false, handle, reason:"mac-unavailable"}` |

Notes:
- `pendingOwner` holds one `{question, askedAt}` or `{start, end, askedAt}`.
  `ledger.ts pending` lists both kinds for "Owner confirms" in `meetly-group`.
- A request's `format` is `meet`, `in_person`, `phone` or `unknown`.
  `meetUrl` only ever holds `https://meet.google.com/xxx-xxxx-xxx`, only on
  a `meet`; the ledger refuses anything else.
- Every calendar mutation goes through `calendar.ts`. It locks the request,
  persists each write's identity, and commits the ledger from the actual result.
  An unresolved write must be resumed, never replayed or bypassed. Reminders
  read the event from a saved calendar read; never copy an id, time or link by hand.
- `slots.ts` keeps the owner's days; `--meal` replaces their window with the
  meal window. Save `meal` with the request for re-offers and guest booking.
- Use each slot's `label` and `dayOfWeek` as printed; never work out a
  weekday yourself. Pass `--locale` for whoever reads the message (the other
  person's locale, like `pt-BR` or `en-US`, from their language or their
  phone's country code).
