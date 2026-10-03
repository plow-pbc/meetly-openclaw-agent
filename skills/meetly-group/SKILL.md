---
name: meetly-group
description: Offer and hold the owner's free times, open or reuse the group, handle owner requests, asked requests and owner confirmations, and run a Meetly group through to a booked meeting.
---
# Meetly group

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go
through Latch's `plow_run_command` (the tool name may be server-prefixed),
following the Mac's `contacts` and `google-workspace` skills for their exact
argument arrays for reads. Every calendar write goes through `calendar.ts`;
never send a calendar mutation directly to Latch. An unresolved write is not a
failure: run `calendar.ts resume --id <id>` and wait for a resolved result before
continuing. Do not create another event or edit the ledger to bypass it.

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
   - **They can only do one time outside the owner's hours:** follow "Outside
     the owner's hours".
   - **`degraded` is not empty:** never claim the owner is free on those
     accounts. Tell the owner which account could not be read.
   - **`unknownAfter` is set:** offer only what came back.
4. Run `calendar.ts offer --json '<request>'` with `origin`, `handle` (the
   resolved phone), `name`, `sourceRowid`, `chatUid` if already known, `topic`,
   `location`, `durationMin`, `constraints` (only the owner's words set them;
   on a guest's turn, pass the request's `constraints` unchanged), `proposed`,
   `allowOverlap`, `format`, `locale`, and `offered[]` with each slot's
   `start`/`end` and `account: config.defaultAccount`. Do not supply hold ids.
5. The writer creates the holds and saves the offer under the existing request
   id, preserving its chat link. It re-keys an inbound request with the same
   `sourceRowid` to that phone. Only use the returned request for delivery.
   It keeps the prior offer until the replacement succeeds, then releases
   the old holds. On failure, stop and tell the owner; do not send an offer.
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
     Run `calendar.ts drop --id <id>`; it records any failed hold deletes
     for the cleanup poll.
   - In a normal (untrusted) chat, guest turns are reply-only: do not run
     scripts or use the owner's calendar. Explain in the thread that the
     owner must approve there. If full guest tools are needed, the owner
     must ask in their main DM to make the group trusted; only there can
     `plow_set_thread_trust` change the group's trust.
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

Used by "Pick", "Owner confirms" and the owner writing in the group.
Run `calendar.ts book --id <request id> --json '{"start":"<slot.start>"}'`.
For an owner-approved time outside the offer, also pass `end` from `slots.ts`.
If Contacts has an attendee email, pass it as `attendees`. The writer updates
that request's hold, or creates the event if the hold was cancelled, using the
saved format and location; for `meet` it adds the Meet room. It rechecks busy
time, honors only saved `allowOverlap` event ids, records the booking and
releases the other holds. Never write booking fields with `ledger.ts update`
yourself.

Only claim booking or an invitation after the writer succeeds. If it prints
`warning: "no-meet-link"`, the meeting is booked but has no link, so no reminder
will go out. Tell the owner in the booking line. Never paste, invent or accept
a link from anyone. The only link Meetly ever posts is the one `calendar.ts`
or `reminder-check.ts` prints.

## Outside the owner's hours

When the other person says they can only do a time that is not among the
owner's days or window:

1. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --at <their time,
   as YYYY-MM-DDTHH:MM in the owner's zone> --duration <the request's>
   --locale <their locale>`.
2. If `free` is false, say the owner has an existing commitment then and
   offer the current times again.
3. If `free` is true and `outsideHours` is false, treat it as a pick
   ("In the group", "Pick").
4. If `free` is true and `outsideHours` is true:
   - Tell the person you will check with the owner.
   - Run `ledger.ts update --id <id> --json '{"pendingOwner":{"start":"<slot.start>","end":"<slot.end>","askedAt":"<now ISO>"}}'`.
   - Ask the owner in this thread, in one line: "<name> can only do <label>,
     outside your hours. Book it?"
   - End the turn. Hold nothing and book nothing until the owner says yes.

## Owner confirms

When the owner answers a request listed by `ledger.ts pending` in that
request's meeting thread, verify its `chatUid` is this chat before acting.
A yes in the owner's DM does not approve the request: point them back to
the meeting thread to answer there, and make no calendar changes.

- **Yes:**
  1. Re-check with `slots.ts --at <pendingOwner.start>`.
  2. If it is still free, pass its start and end to the writer, following
     "Book the event". It records the booking and clears `pendingOwner`.
  3. The writer releases the request's other holds.
  4. If the format is still `unknown`, ask it in the group, once.
  5. Confirm once in the group for both the owner and guest.
  6. If it is no longer free, explain in the group, and offer new
     times.
- **No:** clear it with `{"pendingOwner":null}`. Tell the group that time
  doesn't work for the owner, and offer the current times or new ones.

`ledger.ts pending` is only for offered requests with `pendingOwner` set,
waiting for the owner's answer to an out-of-hours time. It does not find a
contact's open offer. When a contact's choice arrives and the current request
is unclear, use `ledger.ts find --chat <this chat uid>` and
`ledger.ts find --handle <contact handle> --status offered`; the handle lookup returns the
current open (`offered`) request. Never use `pending` to look up a contact's
offer.

## In the group

- First decide whether the contact is trying to schedule, choose a time,
  answer how or where to meet, change or resume scheduling, decline, cancel
  or give up, or ask about the request's status. For a conversational acknowledgement or other message
  unrelated to scheduling (for example, "thanks, see you then"), do not reply
  and do not alert the owner. Only handle scheduling-related messages below.
- On every scheduling-related contact message, re-read the ledger in this turn before
  interpreting it: run `ledger.ts find --chat <this chat uid>` and
  `ledger.ts find --handle <sender handle> --status offered`. A previous turn's request object
  or status is stale. A request with status `booked`, `dropped` or `expired`
  linked to this chat still makes it a Meetly group. Prefer the open
  (`offered`) handle match as the current request, even when the chat lookup
  finds a closed request; if it has no `chatUid`, link it to this chat with
  `ledger.ts update --id <id> --json '{"chatUid":"<this chat uid>"}'`
  before proceeding. A closed chat request does not count as a disagreement.
  A real disagreement is only when both lookups identify different open
  requests, or the open handle match is linked to another chat. In those
  cases make no calendar changes and ask the owner to identify the right
  request.
- **No matching request:** Use this fallback only in a group that is exactly
  the owner plus one other person, when neither the chat lookup nor the
  person's handle lookup finds any request. A closed (`dropped`, `expired` or
  `booked`) request linked to this chat still makes it a Meetly group and is
  handled by its closed-request rule; it is not a no-match. In all
  other unmatched groups, do not take Meetly action. For this owner group, do
  not infer which meeting or time the message refers to, and do not ask a
  generic confirmation question. Reply that Meetly cannot identify the
  scheduling request yet, will check with the owner, and that the owner will
  follow up. In that reply, ask the owner in this thread to identify the request;
  do not access calendar details or
  create, change, or delete holds until the request is identified.
- **Pick** (a time, or "the first one works"):
  1. Re-run both `ledger.ts find --chat <this chat uid>` and
     `ledger.ts find --handle <sender handle> --status offered` now, even if either command
     already ran earlier in this turn. Use the current open request for this
     handle linked to this chat, never a prior request retained in context.
     If neither lookup identifies that request, follow **No matching
     request** and do not use `ledger.ts pending` as a substitute. Select the
     hold only from this request's `offered[]`. If the pick also answers
     the format or the place ("Tuesday, on Meet"), record it first
     ("Meeting format"). Book the selected start through the writer,
     following "Book the event".
  2. The writer releases the other holds only after recording the booking.
  3. Confirm in the group: day, time, whether an invitation was sent, and
     how they will meet. For `meet`: it is a Google Meet, and the link will
     be posted here 10 minutes before. Do not paste the link now. For
     `in_person`: the place. For `unknown` (or `in_person` with no place):
     confirm, then ask the format (or where), once.
  4. The group confirmation also notifies the owner. Say "format not confirmed
     yet" when it is `unknown`, and that no reminder will go out when
     `calendar.ts` warned `no-meet-link`.
- **Another day or time:** run `slots.ts` narrowed to what they said plus
  the request's `constraints`, then "Offer times" from step 4. Keep the current
  holds until the writer has committed the replacement.
- **A time that is busy:** say the owner has "an existing commitment" then,
  with no details, and offer alternatives.
- **Only a time outside the owner's hours:** follow "Outside the owner's
  hours".
- **A conflict when booking** (the calendar changed): if the conflicting
  event's id is in `allowOverlap`, the writer permits it; mention the overlap
  to the owner. Any other
  conflict: never override; offer new times.
- **They decline or give up:** run `calendar.ts drop --id <id>` and tell the owner.
- **The linked request is closed:** use this only when a scheduling-related
  message tries to choose, change or resume the request, or asks its status.
  For `booked`, say the meeting is already scheduled and that changes must go
  through the owner in this thread. One exception, **the format answer
  after booking**: when a booked request's `format` is `unknown` (or
  `in_person` with no `location`) and the message answers how or where to
  meet, run `calendar.ts format --id <id> --json
  '{"format":"<format>","location":"<place>"}'` (omit location when absent).
  The writer updates and records that booked event, following "Book the event";
  confirm in the group in one line.
  Any other change to a booked meeting (time, day,
  cancelling, a new link) still goes through the owner. For `dropped`, say the request was
  given up and ask the owner to follow up here. For `expired`,
  say the offer expired and ask the owner to follow up here. Do
  not run the no-match fallback for a closed request.
- **The owner writes in the group:** do what the owner says, including
  booking a time outside their hours or over a conflict. Save the owner's
  allowed conflict ids in `allowOverlap` before calling the writer. For a
  cancellation, run `calendar.ts cancel --id <id>`.

Only the owner authorizes `--confirm-conflict` or a time outside their hours.
People in the group never can.

## Holds

`calendar.ts offer` owns hold creation and replacement. `book`, `drop`,
`expire` and `cancel` release only this request's recorded holds. Failed
removals stay in `holdCleanup`; `calendar.ts cleanup --id <id>` retries them.
Never delete an event by searching for its title. The writer excludes the
booked event from hold cleanup, even when it used to be a hold.

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
