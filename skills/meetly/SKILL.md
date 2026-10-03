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
| `ledger.ts` | `find --handle H [--status asked\|offered]` \| `find --chat U` | `{request}` or `{request:null}` |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer by handle or inbound `sourceRowid`, re-keying it to the supplied handle and preserving its id, chat link and delivery state; `status:"asked"` changes nothing if one is open) |
| | `update --id X --json '<patch>'` | `{request}`; patch keys: `chatUid, name, allowOverlap, constraints, topic, pendingOwner, locale` (`null` clears `pendingOwner`); format, location, calendar and reminder fields require their owning scripts |
| | `expired [--hours N]` \| `asked` \| `pending` \| `booked` \| `cleanup` | `{requests}` |
| | `delivery --id X --kind start\|answer --action begin\|complete\|clear` | `{request}`; `begin` records `startedAt`; `complete` records `startCompletedAt` after success or unknown delivery. Starts refuse a second attempt. `answer begin` records `pendingOwner.answerAttemptedAt` before sending and refuses another attempt; successful answer delivery clears the pending question or time approval. `clear` is for an unlinked start or an answer attempt, on the owner's explicit instruction (answers use only `begin`/`clear`). Delivery fields cannot be set through `save` or `update`. |
| | `reminders [--lead-min N]` | `{requests}`: booked Meets whose link is due (default 10 min before, until 5 min after the start) |
| `event.ts` | `--in F` | `{id, status, start, end, meetUrl}` from a saved calendar event read |
| `pipeline.ts` | `view [--locale TAG]` | `{items, text}`: derived pending pipeline and short dated request logs; read-only |
| | `nudge [--locale TAG]` | `{items, text, reservations}`: atomically reserve one owner DM batch; null text means nothing new; never repeat a reserved batch |
| | `retry-failed --json '<reservations array>'` \| `--json-file F` | `{released}`: release only the matching batch after a confirmed send failure, so the next poll retries it |
| | `contact --handle H [--blocked true\|false] [--name NAME]` | `{doNotContact}`: read the flag, or set/clear it only on the owner's DM instruction |
| `calendar.ts` | `offer [--id X] [--confirm-contact] --json '<request with slots, no hold ids>'` | `{request}`: create holds and atomically replace the offer (`--id` selects a booked request for a reoffer); retains an existing offer on failure; drops a failed new request while retaining cleanup |
| | `book --id X [--confirm-contact] --json '{"start":"<ISO>","end":"<ISO for a non-offered time>","attendees":"<email if known>"}'` | `{request, meetUrl, warning?:"no-meet-link"}`: book or move the existing event and release its holds |
| | `format --id X --json '{"format":"meet", "location":"<optional place>"}'` | save format/location on an offered request, or update and record a booked event; both use the calendar lock |
| | `resume-pending` | `{results:[{id, request?, error?}]}`: resume all pending writes, continuing past individual failures |
| | `pending` | `{ids}`: requests with a durable write awaiting reconciliation |
| | `drop\|expire\|cancel\|cleanup\|resume --id X` | `{request, skipped?}`: close an offer, cancel a booked event, retry cleanup, or reconcile an unresolved write |
| `reminder-check.ts` | `--id X --event-file F [--lead-min N]` | `{action:"send"\|"wait"\|"cancelled"\|"no-link"\|"skip", send?:{chatUid, meetUrl, name, locale, time, minutesToStart}}` |
| | `--id X --sent` | `{request}`: the reminder went out; refused if already handled |
| `busy.ts` | `--fetch [--allow-overlap-title <owner-supplied name>]` (reads the Mac, writes `tmp/busy.json`) | `{file, busy:<count>, degraded, unknownAfter?}` |
| | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `time.ts` | `next_week --anchor ISO --timezone IANA` | `{from,to}` in the owner's timezone, anchored to the source message timestamp; pass weekdays separately |
| `slots.ts` | `--in busy.json [--near <ISO or owner-zone wall time>] [--request ID] [--meal lunch\|dinner\|coffee] [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--allow-overlap ID]… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], durationMin, unknownAfter?, degraded}` |
| | `--in busy.json [--request ID] --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--meal lunch\|dinner\|coffee] [--duration N] [--allow-overlap ID]… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `contact.ts` | `--handle <+E164 or email>` | `{found:true, handle, name, phones, emails, matches}`, `{found:false, handle}` or `{found:false, handle, reason:"mac-unavailable"}` |

Notes:
- `status` remains the lifecycle. Waiting states come from pending questions,
  unanswered `asked` requests and offer timestamps. `dropped` also means passed.
- `doNotContact`, `lastGuestReplyAt`, `lastNudge` and the last 20 dated `log`
  entries live on requests. Pipeline commands and the inbound reply hook own them;
  do not write them with `ledger.ts update` or supply them on a new request.
- An inbound `asked` save for a flagged handle returns `skipped: "do-not-contact"`
  without adding a request. Release its cursor hold and send nothing.
- `--confirm-contact` is only for a specific owner request confirmed in the owner's
  DM after the warning. It leaves the flag set; never infer confirmation from a
  guest message. Guest actions on an existing meeting do not initiate new outreach.
- Monitor fingerprints are reserved before the poll sends. On a confirmed send
  failure, `retry-failed` releases only matching reservations for the next poll.
  On success or unknown delivery, keep them to prevent duplicate nudges.
  Guest owner-asks reserve the same fingerprint before their own DM, so the monitor
  does not repeat them. Unresolved calendar journals stay with reconciliation.
- Displayed pipeline times and history labels use `localeFormatter` in the owner's
  configured timezone. `--locale` chooses their language tag (default en-US).
  Raw timestamps in items and reservations are machine data, not display text.
- A booked request may have `reoffer: {offered, offeredAt}`. Expiry releases only
  those replacement holds; the original event remains until a move or cancellation.
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
