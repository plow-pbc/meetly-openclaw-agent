---
name: meetly-email
description: Open and deliver owner-authorized email scheduling threads.
---
# meetly-email

Scripts are `node /opt/plow/skills/meetly/scripts/<name>.ts`. Calendar writes use `calendar.ts`.

## Email requests

Use this flow when the owner asks for email outreach, including an ask made
over email. Their request authorizes the send; do not ask for a second approval.
Keep the whole scheduling exchange in one email thread.
Start new outreach only from the owner's main DM or the owner's own email turn.
If requested in a phone group, have the owner repeat the outreach request in
their DM so follow-up questions stay private: the base routes email finals back
to an originating trusted group.

1. Resolve one email address from the owner's words, the current email thread,
   or Contacts. If ambiguous or missing, ask the owner privately and stop before
   creating holds. Do not require or substitute a phone number.
2. Read `ledger.ts find --handle <email>` (or `--chat <this thread uid>` for an
   existing thread). Reuse an existing email request. An open text request stays
   on its original channel; tell the owner before starting anything else.
   If `startedAt` exists without `chatUid`, do not send again. Only an explicit
   owner instruction may clear that attempt with `ledger.ts delivery --id <id>
   --kind start --action clear`.
3. Read `meetly-group` and follow "Read the calendar" and the slot-search rules in "Offer times".
   Resolve next week to explicit dates, preserve the owner's constraints and
   find three times with `slots.ts --count 3`. Save them with `calendar.ts offer`
   using `channel: "email"`, `origin: "owner"`, `handle: <email>`, name, topic,
   meal when applicable, duration, format, location, locale, constraints and offered slots with the
   default calendar account. Preserve the channel on every re-offer. If the owner
   is starting the request in an email thread already containing the guest,
   save that thread's `chatUid`. Do not use `meetly_offer_owner_group` for email.
4. Once the writer has created the holds, compose the opener as Meetly, naming
   the owner, topic and three slot labels and asking which works. State the
   owner's configured time zone in every emailed offer, including the first opener
   and replacement times (for example, "all times Pacific"). For a new
   thread, run `ledger.ts delivery --id <id> --kind start --action begin` before
   sending. Read `request-view.ts --id <id>` and ask about details only when its
   `askDetails` is true. For coffee, lunch or dinner, ask only where to meet;
   never offer phone or Google Meet as meal formats.
   Call `plow_send_email` with `to: [<email>]`, a subject naming the meeting,
   and the opener as `body`. The base includes the owner; do not assemble CCs.
   For an already-linked request, send to its `chatUid` instead, without another
   start attempt or format question.
5. On a new-thread receipt with `sent: true` or `sent: "unknown"`, record
   `ledger.ts delivery --id <id> --kind start --action complete`. If the receipt
   contains `chat_uid`, immediately save it with `ledger.ts update --id <id>
   --json '{"chatUid":"<chat_uid>"}'`. If it has no uid, retain the start attempt,
   tell the owner delivery/thread tracking is uncertain, and never repeat the send.
   On the first reply, the guest tool links the request using the server's thread
   participants, including when a CC'd assistant replies instead of the guest.
   On a definite send failure, stop and drop the request through `calendar.ts drop`.
6. Guest tools handle selection, alternative times and decline. Relay their
   results into this thread with `plow_send_email`. Booking always invites the
   saved guest address; other participants become invitees only on an explicit
   request. For owner-side bookings, pass additional requested emails in
   `attendees`; the writer includes the guest automatically. A CC'd assistant
   choosing for the guest does not become an attendee.
7. Confirm a successful booking in the thread with the time and invitation
   result. For a Meet, include only the writer's returned `meetUrl`; the invitation
   also carries the link. There is no scheduled email reminder. Your final may
   briefly summarize the result privately to the owner; it is never the guest's
   confirmation.

For questions Meetly cannot answer, use `meetly_ask_owner` to record the pending
question, then ask the owner in your final text. Stay quiet in the email thread;
do not send a second DM or claim the ask was delivered before the final. Resolve
the owner's reply using `meetly-confirm`, "Owner confirms".

Greet the guest, never the owner, in every group introduction; use
"Hi" without a name if the guest's participant name is unavailable. Never use the
owner's sender name as the greeting. Owner-only coordination stays in the owner's
DM: never append "Patrick, let me know in our DM" or requests for overlap permission
to an offer addressed to the guest.
