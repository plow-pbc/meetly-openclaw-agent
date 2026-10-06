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
| `poll.ts` | `batch` \| `done <batch id>` | `{batch}`: what the poll job woke you for, or `null`; `done` clears it |
| `cursor.ts` | `get` \| `set <rowid>` \| `hold <rowid>` \| `release` \| `fail` \| `ok` | the cursor `{rowid, held?, …}`; `set` stops below `held` until the ledger has a request with that `sourceRowid`; `fail` → `{failingSince, warn}` |
| `request-view.ts` | `--id X` | Group-safe request view with `askDetails`; reserves any permitted format/place question before returning it |
| `ledger.ts` | `find --handle H [--status asked\|offered]` \| `find --chat U` \| `find --name N` | `{request}`; chat lookup is exact and a name miss returns `{request:null}` |
| | `add --json '<obj>'` \| `--json-file F` | `{request}` (refused if the person already has an open request) |
| | `save --json '<obj>'` \| `--json-file F` | `{request}` (creates, or replaces the current open offer by handle or inbound `sourceRowid`, re-keying it to the supplied handle and preserving its id, chat link and delivery state; `status:"asked"` changes nothing if one is open) |
| | `update --id X --json '<patch>'` | `{request}`; patch keys: `chatUid, name, constraints, topic, pendingOwner, locale` (`null` clears `pendingOwner`); other fields belong to their owning scripts |
| | `expired [--hours N]` \| `asked` \| `pending` \| `booked` \| `cleanup` | `{requests}` |
| | `delivery --id X --kind start\|answer --action begin\|complete\|clear` | `{request, delivery?}`: `begin` records the attempt before sending (a start returns `delivery.state: reserved`, `sendNow: true`; starts and answers refuse a second attempt); `complete` records success or unknown delivery; `clear` resets an unlinked start or an answer attempt, only on the owner's explicit instruction |
| | `reminders [--lead-min N]` | `{requests}`: booked Meets whose link is due (default 10 min before, until 5 min after the start) |
| `event.ts` | `--in F` | `{id, status, start, end, meetUrl}` from a saved calendar event read |
| `calendar.ts` | `offer [--id X] --json '<request with slots, no hold ids>'` | `{request}`: create holds and atomically replace the offer; uses explicit, saved, meal-default or configured `durationMin` and requires matching intervals; retains an existing offer on failure; drops a failed new request while retaining cleanup |
| | `approve-time --id X --json '{"start":"<approved time>"}'` | `{approved,request,...}`; a time approval never grants an overlap. On `TIME_APPROVAL_BUSY`, use `slots.ts --request X --near <near> --no-overlap` |
| | `book --id X --json '{"start":"<ISO>","end":"<ISO for a non-offered time>","attendees":"<email if known>"}'` | `{request, confirmationTime, meetUrl, warning?:"no-meet-link"}`: book and release the other holds |
| | `format --id X --json '{"format":"meet", "location":"<optional place>"}'` | save format/location on an offered request, or update and record a booked event; both use the calendar lock |
| | `duration --id X --json '{"durationMin":60,"topic":"…","offered":[{"start":"…","end":"…"}]}'` | `{request}`: atomically replace duration, topic and holds on an open request |
| | `resume-pending` | `{results:[{id, request?, error?}]}`: resume all pending writes, continuing past individual failures |
| | `pending` | `{ids}`: requests with a durable write awaiting reconciliation |
| | `drop\|expire\|cancel\|cleanup\|resume --id X` | `{request, skipped?}`: close an offer, cancel a booked event, retry cleanup, or reconcile an unresolved write |
| `reminder-check.ts` | `--id X --event-file F [--lead-min N]` | `{action:"send"\|"wait"\|"cancelled"\|"no-link"\|"skip", send?:{chatUid, meetUrl, name, locale, time, minutesToStart}}` |
| | `--id X --sent` | `{request}`: the reminder went out; refused if already handled |
| `busy.ts` | `--fetch [--from ISO --to ISO] [--allow-overlap-title <owner-supplied name>]` (reads the Mac, writes `tmp/busy.json`) | `{file, busy:<count>, degraded, unknownAfter?}` |
| | `--in F [--in F2…] [--max 100]` | `{busy:[{start,end,id,account}], unknownAfter?, degraded}` |
| `time.ts` | `next_week --anchor ISO` | `{from,to}` in the owner's timezone, anchored to the source message timestamp; pass weekdays separately |
| `slots.ts` | `--in busy.json [--near <ISO or owner-zone wall time>] [--request ID] [--meal lunch\|dinner\|coffee] [--duration N] [--days mon,thu] [--after HH:MM] [--before HH:MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--week this\|next] [--asap] [--start-time HH:MM] [--allow-overlap '{"account":"…","id":"…"}']… [--exclude ISO]… [--count N] [--locale TAG]` | `{slots:[{start,end,dayOfWeek,label}], durationMin, resolvedConstraints, incomplete?, unknownAfter?, degraded}` |
| | `--in busy.json --at <ISO or YYYY-MM-DDTHH:MM in the owner's zone> [--meal lunch\|dinner\|coffee] [--duration N] [--allow-overlap '{"account":"…","id":"…"}']… [--locale TAG]` | `{slot, free, reason?: busy\|too-soon\|unknown, outsideHours, degraded}` |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `contact.ts` | `--handle <+E164 or email>` | `{found:true, handle, name, phones, emails, matches}`, `{found:false, handle}` or `{found:false, handle, reason:"mac-unavailable"}` |
| `pipeline.ts` | `view [--locale TAG]` | `{items, text}`: derived pending pipeline; read-only |
| | `nudge [--locale TAG]` | `{items, text, reservations}`: atomically reserve one owner DM batch; null text means nothing new; never repeat a reserved batch |
| | `retry-failed --json '<reservations array>'` \| `--json-file F` | `{released}`: release only the matching batch after a confirmed send failure, so the next poll retries it |
| | `contact --handle H` | `{doNotContact}`: read the flag; changes require `meetly_contact_preference` in the owner's main DM |

Notes:
- `status` remains the lifecycle. Waiting states come from pending questions,
  unanswered `asked` requests and offer timestamps. `dropped` also means passed.
- The ledger stores `blockedHandles`; requests store `contactApproved`, `lastGuestReplyAt` and `lastNudge`.
  The contact tools, calendar writer, pipeline commands and inbound reply hook own them;
  do not write them with `ledger.ts update` or supply them on a new request.
- An inbound `asked` save for a flagged handle returns `skipped: "do-not-contact"`
  without adding a request. Release its cursor hold and send nothing.
- Confirm flagged requests with `meetly_confirm_contact` only after the owner's
  main-DM confirmation. It retains the flag and grants scheduling for that request.
  Setting the preference again revokes prior request confirmations.
- Monitor fingerprints are reserved before the poll sends. On a confirmed send
  failure, `retry-failed` releases only matching reservations for the next poll.
  On success or unknown delivery, keep them to prevent duplicate nudges.
  Guest owner-asks reserve the same fingerprint before their own DM, so the monitor
  does not repeat them. Unresolved calendar journals stay with reconciliation.
- Displayed pipeline times use `localeFormatter` in the owner's
  configured timezone. `--locale` chooses their language tag (default en-US).
  Raw timestamps in items and reservations are machine data, not display text.
- A booked request may have replacement `offered` times and `offeredAt`. Expiry releases only
  those replacement holds; the original event remains until a move or cancellation.
- `pendingOwner` holds one `{contact, askedAt}`, `{question, askedAt}` or `{start, end, askedAt}`.
  `ledger.ts pending` lists them: route contact decisions to `meetly-pipeline`; questions and time approvals go to "Owner confirms" in `meetly-confirm`.
- A request's `format` is `meet`, `in_person`, `phone` or `unknown`.
  `meetUrl` only ever holds `https://meet.google.com/xxx-xxxx-xxx`, only on
  a `meet`; the ledger refuses anything else.
- Choose duration from the meeting context and record it on each saved request; new group offers require `durationMin`. Slot search uses explicit duration, then saved request duration, then the meal default, then config.durationMin. Change duration through `calendar.ts duration` so the new duration and replacement holds commit together.
- Raw calendar commands reject `allowOverlap` and `allowOverlapTitles`. New overlap authorization uses `meetly_offer_owner_dm`, which verifies the runtime owner and main DM session before calling the internal offer writer. The DM tool has no `durationMin` argument: it uses the saved duration, then meal default or configured fallback; mismatched intervals are errors.
- Every calendar mutation goes through `calendar.ts`. It locks the request,
  persists each write's identity, and commits the ledger from the actual result.
  An unresolved write must be resumed, never replayed or bypassed. Reminders
  read the event from a saved calendar read; never copy an id, time or link by hand.
- `slots.ts` keeps the owner's days; `--meal` replaces their window with the
  meal window. Save `meal` with the request for re-offers and guest booking.
- Explicit dates/ranges extend slot search beyond the default horizon. `--week this|next`
  resolves the owner's relative week and rejects manual from/to dates. Save its
  `resolvedConstraints`; never recompute the week. `--asap` ranks earliest starts
  from now while preserving minimum notice. If `incomplete` is present, fetch its
  `requiredCoverage`; missing calendar data is not "no free time".
- Use each slot's `label` and `dayOfWeek` as printed; never work out a
  weekday yourself. Pass `--locale` for whoever reads the message (the other
  person's locale, like `pt-BR` or `en-US`, from their language or their
  phone's country code).

## Meeting format

`format` is how the meeting happens: `meet` (Meetly creates a Google Meet),
`in_person` (a place), `phone`, or `unknown`. It counts only when the words
say it, from the owner's request or from the other person:

- `meet`: "Google Meet", "Meet", "video call", "videochamada", "online",
  "por vídeo".
- `in_person`: "in person", "presencial", "pessoalmente", or a named place
  ("at Starbucks Paulista", "no escritório"). Put the place in `location`.
- `phone`: "by phone", "por telefone", "call me at <number>".
- Anything else is `unknown`, including "call", "ligação", "a quick chat",
  and "coffee" or "lunch" with no place. Never guess from the topic. A Zoom
  or other link someone sends is not `meet`: leave the format `unknown` and
  put what they said in `location`.

Pass `locale` with every save: the other person's language tag, the same one
used for `slots.ts --locale`.

An answer that arrives before booking is recorded with
`calendar.ts format --id <id> --json '{"format":"<format>","location":"<place>"}'`
(drop `location` when there is none). Before composing a reply, use the scheduling
tool's request view or run `request-view.ts --id <id>` after the calendar work.
Ask format/place only when `askDetails` is true. The view reserves that one question;
ask it in the current reply and never repeat it. Missing details never block scheduling.
