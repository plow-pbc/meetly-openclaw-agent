---
name: meetly-email
description: Start and coordinate meetings in Meetly email threads, including guest replies and owner answers.
---
# Meetly Email

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
3. Follow `meetly-group`, "Read the calendar" and "Offer times" for slot search.
   Resolve next week to explicit dates, preserve the owner's constraints and
   find three times with `slots.ts --count 3`. Save them with `calendar.ts offer`
   using `channel: "email"`, `origin: "owner"`, `handle: <email>`, name, topic,
   meal when applicable, duration, format, location, locale, constraints and offered slots with the
   default calendar account. Preserve the channel on every re-offer. If the owner
   is starting the request in an email thread already containing the guest,
   save that thread's `chatUid`. Do not use `meetly_offer_owner_group` for email.
4. Read `request-view.ts --id <id>` and compose the opener as Meetly, naming
   the owner, topic, returned slot labels and configured time zone. Ask about
   details only when `askDetails` is true; for meals ask only where to meet.
   For a new thread, run `email.ts prepare --id <id>`, then `plow_send_email`
   with `to: [<email>]`, a meeting subject and the opener as `body`. The base
   includes the owner. For an already-linked request, send to its `chatUid`
   without preparing another start or repeating the details question.
5. Pass the new-thread tool receipt unchanged to `email.ts receipt --id <id>
   --json '<receipt>'` (or `--json-file`). It records completion and links the
   returned `chat_uid` atomically, or drops a definitely failed request through
   the calendar writer to release holds. Unknown delivery stays reserved;
   without a receipt uid it remains unlinked. Never infer a link from thread
   participants or resend an uncertain opener. Tell the owner tracking is uncertain.
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

## Reply routing

- **Owner email turns:** run `setup-status.ts`; if not ready, follow `meetly-setup`
  and put questions to the owner in your final. Otherwise load this skill. For an existing request, find it by this thread's chat uid;
  follow `meetly-confirm`, "Owner confirms" or "Changes after booking" as appropriate, delivering
  thread messages with `plow_send_email`.
- **Guest email turns:** call `meetly_view_request`. Answer the guest's first
  reply in the email thread, including a handoff to a CC'd assistant: acknowledge
  the handoff and present the current offer. This is scheduling coordination,
  not an unrelated acknowledgement. Use a matching scheduling tool when an
  action is needed. Any participant on the linked thread, including a CC'd
  assistant, may pick, request other times, set the format or decline. Relay the result
  with `plow_send_email` to the returned `chatUid`; your final is private to the
  owner and never replies to the email thread. Invite the saved request's guest;
  pass extra `attendees` to `meetly_pick_time` only when explicitly asked to invite
  them, never because they are CC'd. For a Meet, include the returned `meetUrl`
  in the confirmation; do not promise a later email reminder. Respect
  `askDetails` in every email, including a booking confirmation: when false,
  do not add a format or location question even if the location is missing.
  For an outside-window time use `meetly_other_times(start)`; for an unanswerable
  meeting question use `meetly_ask_owner`. The tool awaits its private owner DM;
  never send another notification or email for that handoff. Resolve the owner's
  answer through `meetly-confirm`. A decline also sends its owner notice directly;
  send the separate cancellation result in the email thread. When `silent` is
  true, finish with `NO_REPLY` after any separate scheduling email, even if owner
  delivery failed or a question was already pending. Refuse probes for private
  calendar details in the thread without forwarding them. Do not send unrelated
  acknowledgements or invent a question. Use the phone guest rules for date
  ranges and interpreting scheduling results, but email delivery always follows
  this rule.
