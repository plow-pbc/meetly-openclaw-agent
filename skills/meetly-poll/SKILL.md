---
name: meetly-poll
description: The scheduled Meetly poll. Read the owner's new iMessages, ask the owner about people who want to meet, and expire stale holds.
---
# Meetly poll

This turn is unattended and has no inbound Plow message. Do the work, send only
the messages listed here, then end. Scripts are
`node /opt/plow/skills/meetly/scripts/<name>.ts`. Mac commands go through
Latch's `plow_run_command` (the tool name may be server-prefixed). Follow the
Mac's own `plow-messages`, `contacts` and `google-workspace` skills for their
exact argument arrays, and always pass `read_paths: ["~/Library/Messages"]`
to `plow-messages`.

This unattended turn has no current conversation and never contacts anyone
new: it opens no group and messages no one who wrote to the owner. Send
meeting notifications with `message` (action `send`, channel `plow`,
accountId `chat`, target the meeting's `chatUid`); the owner is in that
thread. For a message to the owner with no meeting thread, use
`owner-chat.ts` and target the printed `chatUid`.

1. Run `setup-status.ts`. If it is not `READY`, or `config.paused` is true, end.
   (Pausing disables this job, so a paused Meetly sends no reminders either.)
   **Reminders** come first, before any messages are read, so a slow batch
   never delays a link:
   1. Run `ledger.ts reminders`. None: go to step 2.
   2. For each request, read its event:
      `plow-gog calendar event primary <eventId> --account <booked.account> --json`.
      Save the whole output with the `write` tool to
      `/var/lib/plow/meetly/tmp/reminder-<id>.json`. If the read fails, skip
      this request: the next poll tries again while the window lasts.
   3. Run `reminder-check.ts --id <id> --event-file <that file>`. It
      compares the event with the ledger, saves any change, and prints
      `action`:
      - `send`: send one message to `send.chatUid` (when it is `null`, to
        the owner's DM instead). Write it in `send.locale`, third person,
        using `send.name` and `ownerName`: the meeting starts in
        `send.minutesToStart` minutes (at `send.time`), with `send.meetUrl`.
        Use that URL exactly as printed; never any other link. Then run
        `reminder-check.ts --id <id> --sent`. If delivery is unknown, still
        mark it sent: never resend.
      - `wait`: the meeting moved; nothing now.
      - `cancelled`: the event was deleted; send nothing.
      - `no-link`: the Meet was removed from the event. Tell the meeting
        thread in one line that no link went out for <name>'s meeting.
      - `skip`: already handled.
2. Run `cursor.ts get`. If `rowid` is `null`: run `plow-messages search
   --order desc --limit 1`, then `cursor.ts set <that rowid, or 0>`, and go to step 6.
   Never scan history.
3. Run `plow-messages search --after-rowid <rowid> --order asc --limit 50`.
   - On failure, or a `blocked` result: run `cursor.ts fail`. If `warn` is
     true, send the owner one DM saying Meetly can't read their messages;
     if the Mac gave an `owner_action`, include it word for word. If the Mac
     is not connected at all, say Meetly needs Plow Latch on their Mac and
     give https://plow.co/download/latch. Go to step 6: it needs no
     message reads.
   - Empty: run `cursor.ts ok` and go to step 6.
4. Keep inbound rows (`is_from_me` false) from direct chats only. Group them by
   `sender`, in rowid order. For each sender:
   1. Run `plow-messages thread --handle <sender> --limit 20` for context.
   2. Decide whether they want to meet, call or schedule something with the
      owner. These are not requests: short codes, verification codes,
      marketing, automated senders, mentions of something already booked,
      and anything unclear.
   3. If the owner replied after the request, skip: the owner is handling it.
   4. If `ledger.ts find --handle <sender>` has a request, skip.
   5. Run `cursor.ts hold <the request's rowid>` (the same rowid you pass as
      `sourceRowid`) before anything else. Until the ledger records a request
      with that `sourceRowid`, `cursor.ts set` stops just below it, so a run
      that fails part-way retries it.
      If you decide after all that it is not a request, run `cursor.ts
      release`.
   6. Run `contact.ts --handle <sender>` for their name, then `ledger.ts save
      --json` with `status: "asked"`, `origin: "inbound"`, `handle`, `name`,
      `sourceRowid` = the request's rowid, `topic`, `meal: "lunch"|"dinner"|"coffee"` when their words describe one,
      `durationMin` only for an explicitly requested length (otherwise omit it:
      code saves 60 minutes for lunch/dinner, 30 for coffee, or `config.durationMin`), `proposed` for any times they proposed, their `locale`, and
      `format`: the format if their words say it (`meetly-group` "Meeting
      format"; otherwise `unknown`). No holds, no group, no message to them.
   7. If the save fails, stop processing senders. Run `cursor.ts set <the
      rowid just below this sender's first row in the batch>` and go to
      step 6.
5. Run `cursor.ts set <highest rowid in the batch>`.
6. Maintenance:
   - Run `calendar.ts resume-pending` before expiry or cleanup. It resumes every
     pending write and reports each result. For results with an `error`, skip
     that request's other mutations and report it to the owner.
   - For each request from `ledger.ts expired`, run `calendar.ts expire --id <id>`.
     The writer rechecks expiry while holding the request lock. If it prints
     `skipped`, do not announce expiry. Otherwise, if its returned request has
     a `chatUid`, tell the group the offer expired; if `holdCleanup` is not empty,
     say some holds still need cleanup. An `asked` request has no holds or group.
   - For each request from `ledger.ts asked --unnotified`, run `ledger.ts
     delivery --id <id> --kind notify --action begin`. If it fails, skip
     this request. Send the owner one line in their DM, in their language:
     "<name or handle> asked about <topic> <when>. Want me to offer times?"
     On success or unknown delivery, run `ledger.ts delivery --id <id>
     --kind notify --action complete`. On a definite failure, leave it
     unnotified for the next poll. If completion cannot be recorded, report
     the error and stop; do not send it again in this turn.
   - For each request from `ledger.ts cleanup`, run `calendar.ts cleanup --id <id>`.
     If a write is unresolved, run `calendar.ts resume --id <id>`; never bypass
     it with a direct calendar command or a hand-written ledger change.
7. If nothing happened, end silently.
