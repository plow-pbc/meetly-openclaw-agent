# Spike records

## Blocker found in code review (cloud, 2026-09-26): `plow_start_thread` in a cron turn

Source: `plow-openclaw-agent` @ `1e73c82`, `plugin/index.ts`.

- `plow_start_thread` looks up the current turn with
  `activeTurns.get(context.sessionKey)`, then does
  `if (!turn) throw new Error("Starting a thread requires an active message")`.
- `activeTurns` is only filled in `receive()`, the handler for an **inbound
  Plow message**, and cleared when that turn ends.
- The `meetly-poll` cron runs an isolated agent turn with no inbound Plow
  message. So `plow_start_thread` throws there, and the inbound flow (spec
  §2.2 step 5.4) cannot open the group as designed.
- Not affected: the owner request (§2.3) and group turns (§2.4) run inside
  inbound Plow messages. `message send` also works outside a turn: `send()`
  does not need one, and target `plow-owner` resolves the owner's DM.

**Decision (2026-10-02): option 2.** The poll asks the owner first, and every
group opens with `plow_start_thread` in the owner's DM. (Until then, option
1 was used: a Meetly script that made the same `POST /v1/chats` from the
poll.)

Options considered:

1. **Script that calls the API `plow_start_thread` uses**, from the poll.
   It copies base plugin behaviour that could change under us.
2. **The poll asks the owner first.** The poll DMs the owner "X wants to set
   up Y; reply ok and I'll open the group". The owner's reply is an inbound
   message, so `plow_start_thread` works in that turn. This breaks the
   decision "create the group automatically, notify the owner afterward".
3. **Change the base image** so a cron turn can start threads (upstream
   `plow-openclaw-agent`). This is outside this repo; the no-fork rule
   applies.


## Meet link through Latch (local, 2026-09-29)

Run on the owner's Mac through `plow_run_command`, Latch's bundled gog
`v0.36.0`, on two throwaway events (both deleted afterwards).

- `plow-gog calendar create primary … --with-meet --send-updates none --json`
  works. The link is at `event.hangoutLink`
  (`https://meet.google.com/xxx-xxxx-xxx`), and again at
  `event.conferenceData.entryPoints[entryPointType=video].uri`;
  `conferenceData.createRequest.status.statusCode` is `success` in the same
  response, so no second read is needed.
- `plow-gog calendar update primary <holdId> --summary … --with-meet --json`
  adds a Meet to an existing plain event (the hold → booked path), with the
  same shape.
- `plow-gog calendar event primary <id> --json` re-reads one event:
  `{event:{id, status, start:{dateTime}, end:{dateTime}, hangoutLink, …}}`.
  After a delete it still exits 0, with `event.status: "cancelled"`.
- Every command's output starts with a `Note: Using direct access token …`
  line before the JSON; text fields (`summary`, the conference name) are
  wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT …>>>` markers. URLs are not.
- `--select id,hangoutLink` prints `{}` on these commands (the fields sit
  under `event`); read the whole object instead.
- **`plow-gog calendar delete` refuses without `--force`** in a
  non-interactive run: `refusing to delete event … without --force
  (non-interactive)`, exit 2. Every hold delete in `meetly-group` needs it.
