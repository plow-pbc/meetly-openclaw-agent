---
name: meetly-group
description: Handle new owner scheduling requests and replacement offers in DMs and groups.
---
# Meetly group

For owner turns and scheduled upkeep. Guest turns use the scheduling tools.

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
The owner is in every meeting thread: confirmations and notifications go
there once. Unresolved meeting questions and time approval asks go privately to the owner. From the
owner's main DM, a follow-up to a known meeting thread uses `plow_reply_to`,
except pending question answers and time-approval results, which use `meetly_answer_owner`.
An unattended poll has no current conversation and uses `message` with the
known meeting chat uid as its target.
For an email request, all thread replies use `plow_send_email` with its saved
`chatUid`, never `message`, `plow_reply_to` or final text. Email finals go
privately to the owner. Read `meetly-email` for opening and delivery.

## Read the calendar

Run `busy.ts --fetch`. For events the owner explicitly allowed overlapping, add
`--allow-overlap-title <owner-supplied event name>` for each name. Matching `{account, id}` references stay in the busy file; slot search uses them without exposing them.
The reader checks every calendar in the config on the Mac itself and writes `/var/lib/plow/meetly/tmp/busy.json`; it prints only
`{file, busy, degraded, unknownAfter?}`. Never run `plow-gog calendar events`
yourself or copy a calendar listing into a file. An account in `degraded`
could not be read: `slots.ts` reports it, and you never claim the owner is
free there. A read-only holiday subscription is not a conflict warning:
omit that notice on a successful write. Other unread calendars and actual
write failures still need attention; never override a real conflict.

## Offer times

Before searching, read `meetly-travel` for in-person requests or travel changes.
For these requests, if `config.travelBase` is absent, ask for their base privately and stop.
Supply explicit travel minutes to search and the writer, including zero for virtual
meetings. Reuse saved estimates only when the place/format and owner decision are unchanged.
Read `meetly-email` for email delivery and `meetly-confirm` for booking or owner answers.

For "next week", run `time.ts next_week --anchor <owner message timestamp>
--timezone <config.timezone>` and use its returned `from`/`to`; pass named
weekdays separately as `days`. For owner DM requests, save those bounds in
`constraints` and pass them as `--from`/`--to` on searches and re-offers.
For a request started in a group,
suggested dates/times are `proposed` and only explicit non-relaxable conditions
are `constraints`. Carry constraints into every re-offer unless the owner changes them.

Pass `--meal lunch|dinner|coffee` to `slots.ts`, including `--at`, and save `meal`.
The script resolves the meal window and duration; an explicit `--duration` wins.
Persist the search result's `durationMin` with its offered slots, rather than
computing a duration yourself.
When the owner changes the duration, update any duration wording in `topic`
and save it with the replacement offer. Keep `topic` to the meeting purpose
or meal ("lunch", "budget review"), without "with <guest name>"; `name`
is stored separately and the calendar title adds it. For example, "30-minute call" becomes
"60-minute call" when changed to an hour. The saved topic supplies calendar
titles and the group label in owner notifications.

1. Resolve one E.164 phone before any calendar read or hold. If none is
   known, ask the owner for a phone; if several match, ask which one. In
   either case, ask in the owner's main DM and end the turn.
   Run `ledger.ts find --handle <resolved phone>`. If it has `startedAt`
   but no `chatUid` before this turn begins delivery, tell the owner a group
   start was already attempted and stop. This check is for an earlier attempt,
   not the reservation just created by a successful `begin` in step 6.
   Only if the owner explicitly asks to clear the attempt and retry,
   run `ledger.ts delivery --id <id> --kind start --action clear` before continuing.
2. Read the calendar.
3. For a replacement offer, pass `--request <id>` to preserve conditions and
   exclude this request's own holds. Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --locale <their
   locale>`, with the request's `constraints` (the owner's) and, on its
   first offer, its `proposed` times: `--days`, `--after`, `--before`,
   `--from`/`--to`, `--duration`, `--allow-overlap`. Slots stay inside the
   owner's days and meeting window; constraints only narrow them.
   - **No slots.** If the person's `proposed` times block it, run again
     without them, keeping `constraints`, and say those times don't work.
     If `constraints` block it, tell the owner which one and suggest
     loosening it; stop.
   - **`degraded` is not empty:** never claim the owner is free on those
     accounts. Tell the owner which account could not be read.
   - **`unknownAfter` is set:** offer only what came back.
4. For a booked request, use "Changes after booking" below.
   Save with `calendar.ts offer --json '<request>'`: `origin`, resolved `handle`,
   `name`, `sourceRowid`, known `chatUid`, `topic`, `location`, `meal` if applicable, optional `durationMin`,
   `constraints` (the owner's conditions), `proposed`, `allowOverlapTitles`, `format`,
   `locale`, and `offered[]` with each slot's `start`/`end`. The writer supplies
   the meal or configured duration and account and resolves only owner-authorized overlap titles.
   In the current group, use `meetly_offer_owner_group` with those same fields
   except identity, `origin`, `chatUid` and account; it supplies the guest and chat.
   Do not supply hold ids.
5. The writer creates the holds and saves the offer under the existing request
   id, preserving its chat link. It re-keys an inbound request with the same
   `sourceRowid` to that phone. Only use the returned request for delivery.
   It keeps the prior offer until the replacement succeeds, then releases
   the old holds. On failure, stop and tell the owner; do not send an offer.
6. Deliver the times:
   - If this is your first reply in an owner-started group, introduce yourself
     as "Meetly, <ownerName>'s scheduling assistant" in their language with the offer.
   - An open request that already has a `chatUid`: post the new times there.
     Ask format/place only when `askDetails` is true.
   - Otherwise, in the owner's DM, run `ledger.ts delivery --id <saved request id>
     --kind start --action begin` exactly once, immediately before sending.
     Success returns `delivery: {state: "reserved", sendNow: true}`: this is
     permission to send now, not evidence of an earlier send. Do not re-run the
     step 1 check, begin again, clear your own reservation, or ask the owner to
     retry. If begin fails, do not send or clear; tell the owner and stop.
     Then call `plow_start_thread` with `members: ["<resolved phone>"]` and
     the opener as `body`.
   - On success or unknown delivery, run `ledger.ts delivery --id <saved request id>
     --kind start --action complete`. If that fails, tell the owner; the
     attempt remains recorded, so never repeat the start automatically.
   - The opener: third person, in their language. Say who Meetly is and whose
     assistant, the topic, and the slot labels, then ask which works. For
     inbound requests, never claim the owner asked.
   - Ask format/place only when `askDetails` is true, in the same opener.
   - If `plow_start_thread` definitely fails, tell the owner what it said and stop.
     Run `calendar.ts drop --id <id>`; it records any failed hold deletes
     for the cleanup poll.
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

An introduction alone, including "Adding Alder, my scheduling agent, to find us a time",
is not a scheduling request. Reply only with a short introduction, such as
"Hi, I'm Meetly, <ownerName>'s scheduling assistant", then wait for the owner's
actual request. Do not ask the guest or group what, when, format or place;
do not search the calendar or create a request from this introduction.

Resolve the recipient from Contacts in the owner's DM; ask if ambiguous.
In the owner's DM, run `pipeline.ts contact --handle <resolved phone>` before
searching or offering. If `doNotContact` is true, warn in one line and ask whether
to schedule this time. Stop until the owner confirms in this DM. Only for that
confirmed request, add `--confirm-contact` to `calendar.ts offer` or `book`;
this does not clear the flag for future requests.
In a group, use the non-owner member from the turn's participants and the group entry tool. Read
`ledger.ts find --chat <this chat uid>` first, including booked or closed requests;
for a pending question or time approval read `meetly-confirm`, "Owner confirms". No match means
start a new request only after the owner makes a scheduling request.

Extract the topic, proposed times, hard conditions, explicit duration, format,
place and owner-authorized overlap titles. Reuse an open request and its chat.
Follow "Offer times" with `origin: owner` in the DM or the group entry tool here.
Check an explicitly preferred start with `slots.ts --in <busy file> --at <ISO>
--duration <minutes> --format <format> --travel <JSON>`. Do not combine `--at`
with date/day/window filters, `--near` or `--count`; those are search options.
For a busy preferred time or few free options in the owner's main DM, read
`meetly-travel`, "Flexible blockers", before searching nearest times or offering.
The inspection and fresh owner answer come first. In groups, or after no flexible
candidate/refusal, offer nearest free times with `slots.ts --near <requested ISO start>`,
preserving duration, explicit travel and hard conditions. If none fit, ask the owner
privately which condition to relax. Confirm offers once in the meeting thread.

## Holds

`calendar.ts offer` owns hold creation and replacement. `book`, `drop`,
`expire` and `cancel` release only this request's recorded holds. Failed
removals stay in `holdCleanup`; `calendar.ts cleanup --id <id>` retries them.
Never delete an event by searching for its title. The writer excludes the
booked event from hold cleanup, even when it used to be a hold.
