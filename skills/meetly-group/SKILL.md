---
name: meetly-group
description: Owner scheduling requests in their DM or a group, asked-request answers, calendar reads and offering times.
---
# Meetly group

For owner turns and scheduled upkeep. Guest turns use the scheduling tools.

For replies to your private travel estimate, follow `meetly-travel`, "Owner
corrections": list bookings, resize travel, finish privately. The recipient lookup
and offer flow below are for scheduling requests.

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go
through Latch's `plow_run_command` (the tool name may be server-prefixed),
following the Mac's `contacts` and `google-workspace` skills for their exact
argument arrays for reads. Every calendar write goes through `calendar.ts`;
never send a calendar mutation directly to Latch. An unresolved write is not a
failure: run `calendar.ts resume --id <id>` and wait for a resolved result before
continuing. Do not create another event or edit the ledger to bypass it.

Messages to the other person come from Meetly, in the third person, using
`ownerName`, in their language (see "Examples"); `format` values are defined in `meetly`, "Meeting format". Reply in the current
conversation with `message` (action `send`, omit target) or a normal final reply.
The owner is in every meeting thread: confirmations and notifications go
there once. Greet the guest, never the owner, in every group introduction.
Owner-only coordination stays in the owner's DM: never append "Patrick, let me know in our DM"
or a request for overlap permission to an offer addressed to the guest.
Copy the selected request's exact `handle` and `chatUid` from the ledger for reads,
writes and delivery; never invent or retype an id from memory or a session slug.

## Read the calendar

Run `busy.ts --fetch`. Only in the owner's DM, for events they explicitly allowed overlapping, add
`--allow-overlap-title <owner-supplied event name>` for each name. Matching `{account, id}` references stay in the busy file; slot search uses them without exposing them.
Overlap permission does not authorize sharing the event title in the group. Keep
private titles in the owner's DM; group offers and confirmations give only meeting times.
Overlap permission alone is not a time selection. "Noon is fine, it can overlap my
other event" grants permission to offer noon, not to book it. In the owner's DM,
use `meetly_offer_owner_dm` with the selected `requestId` for an existing meeting and `allowOverlapTitles` to resolve the named
permission, re-offer and hold times, then let the guest choose. Never write
`allowOverlap` with the ledger CLI. Only an explicit booking instruction such as "book noon" selects it
on the owner's behalf (`meetly-confirm`, "Book the event").
For an overlap re-offer, use `slots.ts --near <owner-authorized start> --request <id>`
with the fresh busy file and its resolved overlap permissions. Offer the returned
slots in order, including the authorized time when available and the nearest
alternatives, while keeping the request's hard conditions.
The reader checks every calendar in the config on the Mac itself and writes `/var/lib/plow/meetly/tmp/busy.json`; it prints only
`{file, busy, degraded, unknownAfter?}`. Never run `plow-gog calendar events`
yourself or copy a calendar listing into a file. An account in `degraded`
could not be read: `slots.ts` reports it, and you never claim the owner is
free there.

## Offer times

Before searching, read `meetly-travel` to prepare format and an explicit travel estimate.
Pass the same `travel` to the group tool, slot search (`--format` and `--travel`), and saved offer.
Use zero minutes for virtual meetings. Never disclose private travel in a group.


Suggested dates/times are `proposed`; only explicit non-relaxable conditions are `constraints`.
Save accepted clock times in `constraints.startTime` (HH:MM), not `proposed`, before searching with `--start-time`.

For "this week" or "next week", pass `week: "this"` or `week: "next"` to the group tool;
for ASAP, pass `asap: true`. In the owner DM, use `slots.ts --week this|next` or `--asap`.
Code resolves Monday–Sunday in the owner's timezone. Never substitute manual from/to
dates for a relative week, including after an error. Pass named weekdays separately.
Save the returned `resolvedConstraints`. ASAP starts from now, including today,
subject to the existing notice, days and hours. Explicit dates can exceed the default horizon.
For DM read bounds for next week, run `time.ts next_week --anchor <source timestamp>`;
still pass `--week next` to the slot search.
Read explicit date ranges with `busy.ts --fetch --from ISO --to ISO` covering the search;
if the search reports incomplete coverage, fetch that range before claiming availability.

Pass `meal: "lunch"|"dinner"|"coffee"` or `slots.ts --meal` when applicable.
Lunch and dinner use their meeting windows; explicit or saved duration takes precedence,
otherwise use 60 minutes for lunch/dinner, 30 for coffee, or `config.durationMin`. An explicit owner start replaces the default meeting window. Keep `meal`, place, format and locale on re-offers.
When the owner changes the duration, update any duration wording in `topic`
and save it with the replacement offer. For example, "30-minute call" becomes
"60-minute call" when changed to an hour.

When the owner only extends dates, run `ledger.ts widen-dates --id <saved id>
--from <first additional date> --to <last additional date>` before searching with
`slots.ts --request <same id>`. Pass only the additional dates; this keeps that
request's other conditions and guest-excluded weekdays. Never copy conditions
from another meeting or rebuild them from chat history.

When the owner replaces saved hard conditions in a group, pass the complete replacement
as `constraints`; an empty object clears them. Omission preserves the saved policy.
For a DM search without `--at`, run `ledger.ts update --id <id> --json '{"constraints":<replacement conditions>}'`
before searching, keeping any hard conditions they did not change. Exact-time checks use the single call below.

1. In the current group, call `meetly_offer_owner_group` with `topic`, required `durationMin`, `travel`, `introduction: "needed"|"already_introduced"`, `meal`, `constraints`,
   `proposed`, `name` as given by the owner in this thread, `format`, `location` and `locale` as known.
   For rescheduling an existing booking in this group, also pass its saved `requestId`.
   Keep its booked duration; changing a booked duration is not supported.
   For a separate meeting in an already-booked group, omit it: the tool coordinates
   privately before calendar access. On `silent: true`, finish `NO_REPLY`.
   It resolves the guest and chat, searches within the owner's conditions and
   holds times itself using your chosen duration; never supply `offered` intervals.
   Choose the duration from the meeting context, honoring an explicit owner length.
   On error, stop. Otherwise continue at step 6 with the returned offer; if `preferencesUnavailable` is true,
   explain that the preferred times do not work and offer the returned alternatives
   in their returned order. For a busy requested date/time, the tool uses the same
   nearest-time ranking as `slots.ts --near`, keeping all hard conditions.
   In the owner's DM, resolve one E.164 phone before any calendar read or hold. If none is
   known, ask the owner for a phone; if several match, ask which one. In
   either case, ask in the owner's main DM and end the turn.
   Run `ledger.ts find --handle <resolved phone>`. If it has `startedAt`
   but no `chatUid` before this turn begins delivery, tell the owner a group
   start was already attempted and stop. Only if the owner explicitly asks to clear the attempt and retry,
   run `ledger.ts delivery --id <id> --kind start --action clear` before continuing.
2. Read the calendar.
3. For an existing request, pass `--request <id>` to preserve conditions and
   exclude this request's own holds. For a search:
   Run `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --locale <their
   locale> --duration <minutes>`, with the request's `constraints` (the owner's) and, on its
   first offer, its `proposed` times: `--days`, `--after`, `--before`, `--from`/`--to`.
   For an exact owner-requested time, run one `slots.ts` call with `--at <requested ISO start>`,
   `--request <id>` when one exists, and the owner's conditions as `--before`, `--after`, `--days`, `--from`/`--to`.
   Explicit conditions replace their saved counterparts; omitted conditions stay.
   Pass only conditions the owner stated; calendar-read bounds and the default search horizon are not conditions.
   For example: `slots.ts --in /var/lib/plow/meetly/tmp/busy.json --request <id> --at 2026-10-29T14:00 --before 16:00`.
   It applies the conditions and saves them on the selected request; do not add or update a ledger request before or after this check.
   When busy, it returns ranked free alternatives on that day ±2 days, reading calendar
   coverage as needed. Present them in this same reply without asking permission to search.
   The matching busy clock pin is removed; no start pin is created. Other hard conditions stay.
   If `degraded` or `alternativesIncomplete` is present, report incomplete coverage rather than no times.
   - **No slots.** If the person's `proposed` times block it, run again
     without them, keeping `constraints`, and say those times don't work.
     If `constraints` block it, tell the owner which one and suggest
     loosening it; stop.
   - **`degraded` is not empty:** tell the owner which account could not be read.
   - **`unknownAfter` is set:** offer only what came back.
4. For new overlap permission, use `meetly_offer_owner_dm` with the selected `requestId` for an existing meeting and `allowOverlapTitles`; the raw CLI cannot authorize overlaps. Otherwise save with `calendar.ts offer --json '<request>'`: `origin`, resolved `handle`,
   `name`, `sourceRowid`, known `chatUid`, `topic`, `location`, `meal` if applicable, optional `durationMin`,
   `constraints` (the owner's conditions), `proposed`, `format`, `travel`,
   `locale`, and `offered[]` with each slot's `start`/`end`. Do not supply hold ids.
5. The writer creates the holds and saves the offer under the existing request
   id, preserving its chat link. It re-keys an inbound request with the same
   `sourceRowid` to that phone. Only use the returned request for delivery.
   On failure, stop and tell the owner; do not send an offer.
6. Deliver the times:
   - If this is your first reply in an owner-started group, introduce yourself
     as "<agentName>, <ownerName>'s scheduling assistant" in their language with the offer.
     If you already introduced yourself, including on an earlier introduction-only
     turn, give just the offer. A new request or first offer does not restart introductions.
     Set the group tool's `introduction` to `already_introduced` in that case,
     or `needed` if this conversation has no introduction yet; follow its reply instruction.
   - An open request that already has a `chatUid`: post the new times there.
   - Otherwise, in the owner's DM, run `ledger.ts delivery --id <saved request id>
     --kind start --action begin` exactly once, immediately before sending.
     `delivery: {state: "reserved", sendNow: true}` is permission to send now; do not
     re-run the step 1 check, begin again or clear it. If begin fails, do not send or
     clear; tell the owner and stop.
     Then call `plow_start_thread` with `members: ["<resolved phone>"]` and the opener as `body`.
   - On success or unknown delivery, run `ledger.ts delivery --id <saved request id>
     --kind start --action complete`. If that fails, tell the owner; the
     attempt remains recorded, so never repeat the start automatically.
   - The opener: third person, in their language. Say who Meetly is and whose
     assistant, the topic, and returned slot labels verbatim (including timezone), then ask which works. For
     inbound requests, never claim the owner asked.
   - If `plow_start_thread` definitely fails, tell the owner what it said and stop.
     Run `calendar.ts drop --id <id>`; it records any failed hold deletes
     for the cleanup poll.
   - If delivery is unknown, continue without `chatUid` and tell the owner.
     Never retry automatically; retry only after the owner explicitly clears
     the recorded attempt (step 1).
   - After a group opens, run `ledger.ts update --id <saved request id>
     --json '{"chatUid":"<chat_uid from plow_start_thread>"}'` immediately. If that update fails,
     report the error and the chat uid to the owner; do not claim the group is linked.
7. The group opener also notifies the owner of who, the topic and the held
   times; do not send a separate DM.

## Owner request

An introduction alone, including "Adding Alder, my scheduling agent, to find us a time",
is not a scheduling request. Reply only with a short introduction, such as
"Hi, I'm <agentName>, <ownerName>'s scheduling assistant", then wait for the owner's
actual request. Do not ask the guest or group what, when, format or place;
do not search the calendar or create a request from this introduction.
End the reply after the guest-facing introduction.
Do not append an owner-addressed line such as "Patrick, just let me know"
or invite the owner to supply scheduling instructions in the group.

In a group, read `ledger.ts find --chat <runtime chat uid>` first, including booked or
closed requests; for a pending question, time approval or booked meeting use `meetly-confirm`.
Otherwise follow "Offer times" with the group tool; it resolves the recipient, so do
not look up Contacts or ask for a phone.

Before DM offers: `pipeline.ts contact --handle <handle>`. Flagged contacts need private confirmation (`meetly-pipeline`), then `meetly_confirm_contact` with the saved request id and searched slots. In groups, use `meetly_offer_owner_group` for the check and private handoff; never separately read or discuss contact preferences. `silent` means no reply.

For email outreach use `meetly-email`; never substitute a phone number.

In the owner's DM, choose the request path from the owner's message:
- A scheduling request with a phone or email handle is a new request. Use that handle
  to resolve the recipient and follow "Offer times". Do not search by name, list existing
  requests or ask whether this is new, even if an old request has the same guest name.
- Only when the owner refers to someone without a handle, first run
  `ledger.ts find --name <guest name>`. Reuse the matched open request's handle and chat.
  If ambiguous, ask which meeting. When no request matches, resolve the recipient from Contacts
  and ask if ambiguous. Unnamed owner-group requests stay in their originating group.

Save the guest name the owner gave in `name`, even when they also supplied a phone
and Contacts has no card; keep it out of `topic`.

Extract the topic, proposed times, hard conditions, explicit duration, format and
place, and, only in the owner's DM, owner-authorized overlap titles. Follow
"Offer times" with `origin: owner`. If a requested time is busy, say there is an
existing commitment and offer the nearest available times right away; do not ask
whether to search or schedule over the conflict. Confirm the offer once in its meeting thread.

For an owner-requested duration change on an open request, read busy times and run
`slots.ts --request <saved id> --duration <minutes>` with the busy file and saved
conditions as in "Offer times". Then run
`calendar.ts duration --id <saved id> --json '{"durationMin":<minutes>,"topic":"<matching topic>","offered":[{"start":"<slot.start>","end":"<slot.end>"}]}'`
with the returned slots. This operation commits duration, topic and replacement
holds together under the calendar lock; use only its returned request for delivery.
Keep duration wording in `topic` consistent. A new group request saves your chosen
duration through `meetly_offer_owner_group` in its first offer. Preserve a saved
duration unless the owner requests a change. Never patch duration with
`ledger.ts update`; use the atomic operation above.

When the owner changes the duration, update any duration wording in `topic` and save it with the replacement offer: "30-minute call" becomes "60-minute call".
Keep `topic` to the purpose or meal; the calendar title adds the name.

## Asked requests

The poll saves a meeting request it finds in the owner's messages as
`asked` and asks the owner about it in the owner's DM. Nobody is contacted
until the owner says yes there or makes a scheduling request in their group
(see "Owner request"). When the owner answers in their DM, run `ledger.ts
asked` and match their answer to a request; if it could be more than one,
ask which and end the turn.

- **Yes:** follow "Offer times" with `origin: inbound`, the request's
  `name`, `sourceRowid`, `topic`, `meal`, `format`, `locale` and `proposed`, and
  preserve the saved `constraints` and merge any conditions the owner gave with the yes. Saving
  the offer turns the request into `offered` under the same id.
- **No:** run `calendar.ts drop --id <id>`. Send nothing to the person.

## Holds

`calendar.ts offer` owns hold creation and replacement. `book`, `drop`,
`expire` and `cancel` release only this request's recorded holds. Failed
removals stay in `holdCleanup`; `calendar.ts cleanup --id <id>` retries them.
Never delete an event by searching for its title.

## Examples

- Right: "Jean is free Tue 29/9 at 12:00." Wrong: "I'm free Tuesday at noon."
- Right: "Jean has an existing commitment then." Wrong: "Jean has Weekly Claw
  at that time."
- Opener (en-US), `askDetails: true`: "Hi Patrick, this is <agentName>, Jean's
  scheduling assistant. Jean would like to set up a call with you. Jean is
  free Tue, 9/29, 12:00 PM; Wed, 9/30, 12:00 PM; or Thu, 10/1, 12:00 PM.
  Which works best, and would you prefer Google Meet or in person?"
