---
name: meetly-travel
description: Handle replies to private travel estimates, including bare numeric corrections; prepare in-person travel.
---
# meetly-travel

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Calendar writes use `calendar.ts`.

## Owner corrections

A reply to your private travel estimate stays in this flow. Resolve its subject
from the conversation: a bare number changes travel unless the owner explicitly
identifies meeting length. This is an existing booking; do not enter the new-request
flow, read `meetly-group`, look up Contacts or search open requests.

1. Run `node /opt/plow/skills/meetly/scripts/ledger.ts booked` without flags.
   Match the returned bookings by person, topic and conversation. If none matches
   or more than one could match, ask privately which booking and stop.
2. Copy the matched `id` into
   `meetly_change_travel` with `requestId` and `travel: {beforeMin: 45, afterMin: 45}`.
   Use the owner's minutes; one symmetric estimate changes both sides. This preserves
   meeting start/end and duration. The override wins over later estimates for this
   meeting; a virtual format needs explicit zero.
3. The writer sends the travel note directly to the owner DM. When it returns
   `silent: true`, finish with exactly `NO_REPLY`: no second message,
   summary or acknowledgement. If `ownerNotified: false`, report only that delivery
   is unconfirmed, without retrying the write or send. On a write error, report it privately without claiming a change.
   Do not notify the guest or create an offer.

When a format/place change cannot fit, keep the booking and ask whether the owner
wants to search replacement times. Once asked, use the proposed format and explicit
travel, preserving owner conditions. If no slots fit, ask privately which condition
to relax. Do not repeat the failed change.

## Meeting format

`format` is `meet` (Google Meet/video), `in_person` (a place), `phone`, or
`unknown`. It counts only when the words say it, except unknown-format meals
assume in person for travel. Anything else is `unknown`, including "call", "ligação"
and "a quick chat". "coffee" or "lunch" with no place gets the meal travel default.
Never guess from the topic for other meetings. An external video link stays in
`location`, with zero travel; it is not a Google Meet link.

Save their language tag as `locale`. From the owner's main DM, record format/place
answers with `meetly_change_format`, supplying `requestId`, `format`, `location`,
explicit `travel` and a guest-facing `confirmation`. It delivers the text-group
confirmation and private travel note; on `silent: true`, finish `NO_REPLY`.
Follow returned guestConfirmation steps for email. For other turns, record answers with `calendar.ts format
--id <id> --json '{"format":"<format>","location":"<place>","travel":{"beforeMin":25,"afterMin":25}}'`;
omit location when absent. Later answers replace earlier ones. Use the tool's
view or `request-view.ts --id <id>` before replying. Ask format/place only when
`askDetails` is true; the view reserves one question, even if delivery is uncertain.
For meals ask only where, never suggest remote options; honor an explicit remote
request. Missing details do not block scheduling.

## Travel

Use the meeting place and the scheduling thread to choose an explicit travel estimate.

Pass `--format` and `--travel '{"beforeMin":25,"afterMin":25}'` to slot search;
save the same `travel` on offers. Minutes are integers 0–120. Choose 15 each side for unknown-place meals unless context supports another estimate;
choose zero for virtual meetings. Code requires your estimate and never chooses it. An unchanged offer keeps its saved estimate at booking; `meetly_pick_time` accepts no travel.
Re-estimate when the place or proposed time changes, passing `travel` to `format` or the new offer. Travel may extend outside
the meeting window. Offers require room but create no travel events until booked.
The writer rechecks, creates private busy children without attendees, carries them
on moves and deletes them on cancellation.

After successful booking/resizing, code sends the travel note directly to the owner DM.
`ownerNotified` confirms delivery; a false value means notification is unconfirmed,
not that the calendar change failed. Never repeat the note or retry the mutation
to resend it. Calendar and ledger CLI results omit private travel data in every chat.
Never include travel minutes in guest/group replies.
