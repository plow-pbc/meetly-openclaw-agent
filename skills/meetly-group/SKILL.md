---
name: meetly-group
description: Handle owner scheduling requests, offers, group bookings and owner confirmations.
---
# Meetly group

For owner turns and scheduled upkeep. Guest turns use the scheduling tools.

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go
through Latch's `plow_run_command` (the tool name may be server-prefixed),
following the Mac's `contacts` and `google-workspace` skills for their exact
argument arrays. Use `plow-gog` exactly as that skill says. Where this skill's
flags differ from `checks/spike.md` §4, the spike wins.

Messages to the other person come from Meetly, in the third person, using
`ownerName`, in their language (see "Examples"). Reply in the current
conversation with `message` (action `send`, omit target) or a normal final reply.
The owner is in every meeting thread: confirmations, notifications and
approval asks go there once, where the guest receives them too. From the
owner's main DM, a follow-up to a known meeting thread uses `plow_reply_to`.
An unattended poll has no current conversation and uses `message` with the
known meeting chat uid as its target.

## Read the calendar

Run `busy.ts --fetch`. It reads every calendar in the config on the Mac
itself and writes `/var/lib/plow/meetly/tmp/busy.json`; it prints only
`{file, busy, degraded, unknownAfter?}`. Never run `plow-gog calendar events`
yourself or copy a calendar listing into a file. An account in `degraded`
could not be read: `slots.ts` reports it, and you never claim the owner is
free there.

## Offer times

1. Resolve one E.164 phone before any calendar read or hold. If none is
   known, ask the owner for a phone; if several match, ask which one. In
   either case, ask in the owner's main DM and end the turn.
   Run `ledger.ts find --handle <resolved phone>`. If it has `startedAt`
   but no `chatUid`, tell the owner a group start was already attempted and
   stop. Only if the owner explicitly asks to clear the attempt and retry,
   run `ledger.ts delivery --id <id> --kind start --action clear` before continuing.
2. Read the calendar.
3. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --locale <their
   locale>`, with the request's `constraints` (the owner's) and, on its
   first offer, its `proposed` times: `--days`, `--after`, `--before`,
   `--from`/`--to`, `--duration`, `--allow-overlap`. Slots stay inside the
   owner's days and window; constraints only narrow them.
   - **No slots.** If the person's `proposed` times block it, run again
     without them, keeping `constraints`, and say those times don't work.
     If `constraints` block it, tell the owner which one and suggest
     loosening it; stop.
   - **`degraded` is not empty:** never claim the owner is free on those
     accounts. Tell the owner which account could not be read.
   - **`unknownAfter` is set:** offer only what came back.
4. Hold each slot ("Holds"). Drop a slot whose hold is refused for a
   conflict. If none are left, tell the owner and stop.
5. Persist the offer immediately after the holds exist, before sending or
   opening a group. Run `ledger.ts save --json '<request>'` with every field:
   `origin`, `handle` (the resolved phone), `name`, `sourceRowid`,
   `chatUid` if already known, `topic`, `location`, `durationMin`,
   `constraints` (the owner's conditions),
   `proposed`, `allowOverlap`, `format` and `locale` (see "Meeting
   format"), and `offered[]` with each `start`/`end`/`holdId`/`account`. `save` creates a request or updates the
   existing open request for that person; it re-keys an inbound request with
   the same `sourceRowid` to that phone, preserving its id and existing
   `chatUid` when the new value is absent. Holds from the replaced offer are
   moved to `holdCleanup` automatically so the cleanup poll can delete them.
   If it fails, delete each hold just
   created, stop and report the ledger error to the owner; do not send an
   offer. If any deletion fails, report those hold ids too.
6. Deliver the times:
   - An open request that already has a `chatUid`: post the new times there.
   - Otherwise, in the owner's DM, run `ledger.ts delivery --id <saved request id>
     --kind start --action begin`. If it fails, tell the owner and stop.
     Then call `plow_start_thread` with `members: ["<resolved phone>"]` and
     the opener as `body`.
   - On success or unknown delivery, run `ledger.ts delivery --id <saved request id>
     --kind start --action complete`. If that fails, tell the owner; the
     attempt remains recorded, so never repeat the start automatically.
   - The opener: third person, in their language. Say who Meetly is and whose
     assistant, the topic, and the slot labels, then ask which works. For
     inbound requests, never claim the owner asked.
   - When `format` is `unknown`, the same opener also asks how they would
     like to meet: Google Meet or in person. When it is `in_person` with no
     `location`, it asks where. Always in that one message, never a second
     one.
   - If `plow_start_thread` definitely fails, tell the owner what it said and stop.
     Delete the new holds and mark the saved request `dropped`; if a hold
     cannot be deleted, record its id and account in `holdCleanup` so
     cleanup can retry.
   - If delivery is unknown, continue without `chatUid` and tell the owner.
     Never retry automatically; retry only after the owner explicitly clears
     the recorded attempt (step 1).
   - After a group opens, run `ledger.ts update --id <saved request id>
     --json '{"chatUid":"<chat uid>"}'` immediately. If that update fails,
     report the error and the chat uid to the owner; do not claim the group is
     linked.
7. The group opener also notifies the owner of who, the topic and the held
   times; do not send a separate DM.

## Owner request

In the owner's DM:

1. Look the person up with `contacts` and resolve the recipient ("Offer
   times" step 1). If more than one contact matches, ask the owner and end the turn.
2. Extract the topic, days or dates, time range, duration, location, the
   format ("Meeting format"), and any events the owner says may be
   overlapped ("you can override Weekly Claw").
3. Find those events by name in the calendar read (every instance, if
   recurring) and pass each id as `--allow-overlap`. If none is found, tell
   the owner and continue without it.
4. If `ledger.ts find --handle <handle>` has an open request, reuse its group
   ("Offer times" step 5).
5. Follow "Offer times" with `origin: owner`.
6. Reply to the owner in one line: group opened, times offered and held.

## Asked requests

The poll saves a meeting request it finds in the owner's messages as
`asked` and asks the owner about it in the owner's DM. Nobody is contacted
until the owner says yes there. When the owner answers, run `ledger.ts
asked` and match their answer to a request; if it could be more than one,
ask which and end the turn.

- **Yes:** follow "Offer times" with `origin: inbound`, the request's
  `name`, `sourceRowid`, `topic`, `format`, `locale` and `proposed`, and
  `constraints` set to any conditions the owner gave with the yes. Saving
  the offer turns the request into `offered` under the same id.
- **No:** run `ledger.ts update --id <id> --json '{"status":"dropped"}'`.
  Send nothing to the person.

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
`ledger.ts update --id <id> --json '{"format":"<format>","location":"<place>"}'`
(drop `location` when there is none). A later answer replaces an earlier
one. Never ask about the format twice in a row: once in the opener, and once
after booking if the pick did not answer it.

## Book the event

Used by "Owner confirms" and "Owner in the group". The
command is the one that step names (`calendar update primary <holdId>` for a
held slot, or `calendar create primary`), always with `--json` and
`--send-updates all`, plus:

- `format` `meet`: `--with-meet`. That creates the Google Meet room.
- `in_person` with a place: `--location <place>`.
- `phone`: `--location "Phone call"`.
- `unknown`: nothing extra.

Then:

1. Save the command's whole output with the `write` tool to
   `/var/lib/plow/meetly/tmp/event.json`.
2. Run `record-booking.ts --id <request id> --event-file
   /var/lib/plow/meetly/tmp/event.json --account <the account the event is
   on>`: the hold's `account` for an update, `config.defaultAccount` for a
   create. It marks the request `booked` with the event id, the time and the
   Meet link. Never write those fields with `ledger.ts update` yourself.
3. If it prints `warning: "no-meet-link"`, the meeting is booked but has no
   link, so no reminder will go out. Tell the owner in the booking line.
   Never paste, invent or accept a link from anyone. The only link Meetly
   ever posts is the one `record-booking.ts` or `reminder-check.ts` prints.

## Owner confirms

When the owner answers a request listed by `ledger.ts pending` in that
request's meeting thread, verify its `chatUid` is this chat before acting.
A yes in the owner's DM does not approve the request: point them back to
the meeting thread to answer there, and make no calendar changes.

- **Yes:**
  1. Re-check with `slots.ts --at <pendingOwner.start>`.
  2. If it is still free, create the event with `plow-gog calendar create
     primary` using the final details ("Owner in the group"), following "Book the
     event". That records the booking and clears `pendingOwner`.
  3. Delete all the request's holds.
  4. If the format is still `unknown`, ask it in the group, once.
  5. Confirm once in the group for both the owner and guest.
  6. If it is no longer free, explain in the group, and offer new
     times.
- **No:** clear it with `{"pendingOwner":null}`. Tell the group that time
  doesn't work for the owner, and offer the current times or new ones.

## Owner in the group

Read `ledger.ts find --chat <this chat uid>` for the current request, including
booked or closed ones. If no request matches, ask the owner which meeting they
mean before changing the calendar. For an out-of-hours approval, follow
"Owner confirms".

- **Book a time:** read the calendar and select the requested slot. Record any
  format or place the owner supplies ("Meeting format"). Update its hold with
  `plow-gog calendar update primary <holdId> --account <account>`, or use
  `calendar create primary` if there is no hold. Use the final title (the topic
  and the person's name, without "Hold:"), location and the person's email as
  an attendee if contacts has one, following "Book the event". Only then delete
  the other holds.
- **Other times:** delete the current holds and follow "Offer times", carrying
  the request's conditions and any changes the owner gives.
- **Format or place after booking:** record it ("Meeting format"), then run
  `plow-gog calendar update primary <eventId> --account <booked.account>`
  following "Book the event".
- **Cancel or drop:** delete the request's holds and, if the owner is cancelling
  a booked meeting, its event. Mark the request `dropped` and clear
  `pendingOwner`.
- The owner can authorize an out-of-hours time or a conflict override. Use
  `--confirm-conflict` only for an overlap they allowed.

Confirm once in the group: day, time, whether an invitation was sent, and how
they will meet. For `meet`, say the link will be posted here 10 minutes before.
Do not paste the link now. For `unknown` (or `in_person` with no place), ask
how or where to meet once. If `record-booking.ts` warned `no-meet-link`, say
no reminder will go out. The group confirmation also notifies the owner.

## Holds

- Create one hold per slot with `plow-gog calendar create primary --summary
  "Hold: <topic> with <name>" --from <slot.start> --to <slot.end>
  --send-updates none --account <config.defaultAccount> --json`, with no
  attendees. Record the returned event id as the slot's `holdId`.
- Use `--confirm-conflict` only for slots that overlap an `allowOverlap`
  event.
- Delete only ids that the ledger records as this request's holds, never
  any other event: `plow-gog calendar delete primary <holdId> --send-updates
  none --force --account <account>`. `--force` is required: without it gog
  refuses every delete in a non-interactive run.
- If a delete fails, add `{holdId, account}` to the request's `holdCleanup`.
  The poll retries it.

## Examples

- Right: "Jean is free Tue 29/9 at 12:00." Wrong: "I'm free Tuesday at noon."
- Right: "Jean has an existing commitment then." Wrong: "Jean has Weekly Claw
  at that time."
- Opener (en-US), format `unknown`: "Hi Patrick, this is Meetly, Jean's
  scheduling assistant. Jean would like to set up a call with you. Jean is
  free Tue, 9/29, 12:00 PM; Wed, 9/30, 12:00 PM; or Thu, 10/1, 12:00 PM.
  Which works best, and would you prefer Google Meet or in person?"
- Opener (pt-BR), format `meet`: "Oi Patrick, aqui é o Meetly, assistente de
  agenda do Jean. O Jean quer marcar um Google Meet com você. Ele está livre
  ter., 29/09, 12:00; qua., 30/09, 12:00; ou qui., 01/10, 12:00. Qual fica
  melhor?" No format question: the request already said Meet.
- Booked, `meet`: "Done: Tue 9/29 at 12:00 PM, on Google Meet. Invitation
  sent. I'll post the link here 10 minutes before." Wrong: pasting the link
  now, or a link someone else sent.
- Reminder: "Patrick, Jean's meeting starts in 10 minutes (12:00 PM). Join
  here: https://meet.google.com/abc-defg-hij"
