# Meetly

Your scheduling assistant, on a text thread. When someone asks to meet you,
Meetly asks you first; when you say yes, it opens a group with them, offers
your free times, holds them on your calendar and books the one they pick. You receive the confirmation in the same group.

An [OpenClaw](https://github.com/openclaw/openclaw) agent on
[Plow Chat](https://howto.plow.co/). It is one person's assistant: your days,
your hours, your calendars, set once in a short chat.

> **Status:** implemented. The on-Mac checks (`checks/spike.md`) and the
> end-to-end run (`checks/manual-scenarios.md`) are still to be done before
> the first deploy.

## What it is

Every five minutes Meetly reads your new iMessages on your Mac, through
[Latch](https://howto.plow.co/latch). When someone is trying to set something
up with you — "coffee next week?" — it asks you in your DM whether to offer
times. Nobody hears from Meetly until you say yes. Then it:

1. opens a Plow group with you and that person,
2. offers three free times from your Google Calendar on your allowed days,
3. holds those times on your calendar so nothing else takes them,
4. asks how you'll meet (Google Meet or in person) when the message does
   not say it, except in a group you started, where missing details are left to you,
5. books the one they pick, invites them if it knows their email, and
   releases the other holds; for a Meet it creates the room,
6. posts the Meet link in the group 10 minutes before the start,
7. confirms in the group, where both you and the other person receive it.

Once you say yes, it does not wait for you: if you are busy, the meeting
still gets booked.

You can also ask it directly: *"set up lunch with Patrick next week — it can go
over Weekly Claw"*. Meetly finds Patrick in your contacts, respects what you
said for that one request, and runs the same group.

Meetly always speaks as your assistant, in the third person: *"Jean is free Tue
29/9 at 12:00"*, never *"I'm free"*. It never texts from your own Messages
account; every conversation with the other person happens in the Plow group,
signed as Meetly.

## What it will and won't do

- **Asks how to meet only when it is not clear.** "A Google Meet on
  Thursday" or "lunch at Fasano" is enough. "A call" or "coffee" with no
  place gets one question, in the same message as the times.
- **Posts only the Meet link it created.** The link comes from the event on
  your calendar, read again just before it is sent: move the meeting and the
  link goes out at the new time; delete it and nothing is sent. A link
  someone writes in the group is never used. Pausing Meetly pauses these
  too.

- **Offers only free time.** Meals use meal windows; other meetings use your
  hours. Both respect your allowed days. Busy time is "an existing
  commitment" — never an event name or detail. If the other person can only
  do a time outside that window, Meetly asks you privately and books it only on
  your yes, then confirms in the group. Unresolved meeting questions also go to your DM.
- **Holds expire.** No answer in 48 hours: the holds are deleted and the
  group is told the times were released.
- **Overlaps only with your word.** Meetly books over an existing event only
  when you name that event and authorize the overlap in your DM. People
  in the group can never unlock a conflict or widen the meeting window.
- **Stays on topic in groups.** The group is for this one meeting. Meetly does
  not read your mail, files or other conversations for the other person.
- **Ignores instructions in messages.** A text that says "ignore your rules"
  is just a text.
- **Skips noise.** Verification codes, short codes, marketing and automated
  senders never get a group. If you already answered the person yourself,
  Meetly stays out of it.

## Setup

The first time you text the line, Meetly introduces itself in one line and
gets to work on what you asked. It asks only what nobody else can tell it:
your name and time zone, when your Plow profile and your Mac cannot supply
them. Your busy calendars are read from the Mac: every calendar you show in
Google Calendar counts, except read-only holiday subscriptions.

Everything else starts at these defaults:

- days: Monday to Friday,
- hours: 09:00 to 18:00,
- meeting length: 30 minutes unless explicitly selected or already saved,
- searches 14 days ahead by default; explicit dates can extend the search.

Change any of it later in plain words ("make my window 10 to 17", "I don't
take meetings on Fridays"), or say "pause Meetly" / "resume Meetly".

## Install (local)

You need Git, Docker Compose, and
[plow-agents](https://github.com/plow-pbc/plow-agents).

```sh
git clone https://github.com/jeanjacintho/meetly-openclaw-agent.git
cd meetly-openclaw-agent

plow-agents login                 # text the printed code
plow-agents lines                 # pick a free line
plow-agents mint LINE_UID         # writes ./plow-credentials before the first up
docker compose up --build -d
docker compose logs -f agent      # wait for: plow-boot: identity resolved …
```

Text the line you minted; setup starts with your first message. By default,
the local dashboard is at <http://localhost:3001> (anyone who can reach it is
admin). Set `HOST_PORT` to bind another loopback port; the container listens
on port 3001 either way.

```sh
docker compose down          # stop, keep settings, holds ledger and schedule
docker compose down -v       # wipe the state volume (fresh setup)
plow-agents revoke           # retire the line in plow-credentials
```

`plow-credentials` is gitignored. Do not commit it.

**Apple Silicon.** The pinned base supports both `linux/amd64` and
`linux/arm64`, including the native Agent Index usage collector. Compose
uses your machine's architecture; no override or source-built base is needed.

## Deploy (cloud)

Build and push the image to a registry you control that Plow can pull, then
deploy it by digest:

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

A cloud host injects the credentials; there is no `plow-credentials` file.
The image lists itself on the [Agent Index](https://aiworthusing.com/agent-index)
as `meetly` (`AGENT_ID`, `AGENT_NAME`, `AGENT_BLURB`, `AGENT_RUNTIME` in the Dockerfile) and
reports its token usage through the base's pinned reporter.

## Your Mac: Latch, Messages and Calendar

Run [Latch](https://howto.plow.co/latch) on the Mac that holds your iMessages,
signed in to the same Plow account, with your Google account connected in
Latch. Meetly uses the Mac's own skills: `plow-messages` to read texts,
`contacts` to find people, and `google-workspace` (`plow-gog`) for your
calendar. Chat works without Latch; reading messages and your calendar does
not. If the Mac is asleep or Latch is closed for more than 30 minutes, Meetly
tells you once and picks up where it left off when the Mac is back — no
message is skipped.

## How it runs

- **Image.** A variant of Plow's
  [OpenClaw base image](https://github.com/plow-pbc/plow-openclaw-agent),
  pinned by digest: the base's gateway, Plow channel and reporter, plus
  Meetly's prompt, skills and its own entrypoint, `boot/preboot.ts`. That is
  the base's `boot/main.ts` step for step, on the base's compiled modules,
  with two additions before the config is synced: the setup gate and a
  60 s request timeout on the Mac relay. Without that timeout OpenClaw caps
  the relay's tool listing at 1500 ms, a Mac round trip takes 0.9-1.8 s, and a turn intermittently had no
  Mac tools at all.
- **Setup gate.** Before each of the owner's DM turns, the `meetly` plugin
  runs `setup-status.ts` and puts its answer at the top of the turn, so setup
  never depends on the model remembering to check. The base owns
  `plugins.load`, so the plugin sits in the state volume's global plugin root
  (`/var/lib/plow/extensions/meetly`), copied there from the image on every
  boot. The scheduling plugin is required: installation failure prevents
  gateway startup. Plugin activation and its config write are required too.
  The owner's name comes from their Plow profile and the time zone from
  their Mac through Latch; setup asks only what neither can answer.
- **Schedule.** One OpenClaw scheduler job (`openclaw cron`), `meetly-poll`:
  an isolated agent turn every five minutes with no automatic delivery,
  registered by `register-crons.ts` when setup finishes. It lives in the state
  volume and survives restarts and rebuilds.
- **Chat.** Your phone DM is the main session and runs setup. A group Meetly
  opened is recognized from its ledger and handled as that one meeting. In an
  existing group with the owner, one guest and Meetly, the owner can request
  scheduling directly; Meetly resolves the guest from the group, links the
  request and offers times there. Owner-group offers supply an explicit duration.
  Other offers and slot searches use the saved duration, falling back to the owner's
  configured default. Code checks interval lengths. Owner-requested duration changes replace the topic,
  duration and holds together under the calendar lock. Unnamed requests stay in
  their originating group; chat lookup requires the exact runtime chat uid.
  Overlap authorization goes through the registered `meetly_offer_owner_dm` tool,
  which verifies the runtime Plow owner and main-DM session before calling the
  internal calendar writer. It uses the saved duration or configured default and has
  no separate duration argument. Raw calendar
  commands reject overlap authorization.
- **Opening groups.** Only in the owner's DM, with the base's
  `plow_start_thread`; new groups are untrusted. Guests receive the six
  scheduling tools in `PLOW_GUEST_TOOLS`; owner turns keep full tools. An uncertain
  delivery is recorded without a chat and never retried automatically; Meetly
  may retry after the owner explicitly clears the recorded attempt. Meeting
  confirmations stay in the group. `meetly_ask_owner` sends meeting questions
  to the owner's DM; `meetly_other_times(start)` sends time-approval requests.
  `meetly_answer_owner` returns
  the owner's answer to that request's recorded group; time approvals use the
  calendar writer. The answer tool is owner-only and is not in `PLOW_GUEST_TOOLS`.
  The private send stays inside Meetly over the public `sendDurableMessageBatch`
  SDK: exposing a general owner-DM tool to guests would let them bypass the
  request scope and one-pending-question gate.
- **Scripts.** Small TypeScript CLIs in `skills/meetly/scripts/`, run directly
  by the image's Node (`node <script>.ts`, no build): setup, the message
  cursor, the request ledger, busy/free-slot math in your time zone, cron
  registration and the owner-DM lookup. Guest tools use the same request-locked
  calendar writer as owner and poll flows. Guest identity uses exact canonical
  phone/email and chat matching; contact lookup also requires exact canonical phone/email matching.
  The model decides; the scripts count.
- **State.** `/var/lib/plow/meetly`: `config.json` (your setup),
  `cursor.json` (last message read), `ledger.json` (requests, offered times,
  hold ids). Writes are atomic and locked.

## Model

Meetly uses the base image's default model and fallback: GLM 5.2 with
Sonnet 5 as the fallback. Meetly does not override the model configuration.
Existing model settings in the state volume are left unchanged.

## Known limitations

- Only direct iMessage chats; group chats and email requests are not read.
- One person per request.
- Groups require a phone number; Meetly asks you for one before reading the
  calendar or creating holds if only an email is known.
- Ask Meetly to cancel a booked meeting; it deletes the event and notifies invitees.
  Rescheduling a booked meeting is still left to you.
- If the model provider is unreachable, that five-minute check is skipped and
  the next one catches up from the same cursor.

## Layout

- `prompt/AGENTS.md` — Meetly's own prompt: who it is first, then the base's
  tool and authority rules word for word, then how Meetly works.
- `skills/meetly-setup`, `skills/meetly-poll`, `skills/meetly-group`,
  `skills/meetly-confirm` — what the agent does in setup, in the scheduled
  check, when the owner asks for a meeting, and when the owner answers,
  books or changes one.
- `skills/meetly/scripts/` — the TypeScript CLIs behind them.
- `boot/` — the entrypoint (`preboot.ts`, the base's boot plus Meetly's
  additions), the setup gate install (`gate.ts`) and the Mac relay timeout
  (`mcp.ts`).
- `plugin/` — the setup gate: an OpenClaw plugin that runs `setup-status.ts`
  before each of the owner's DM turns and hands the model the answer.
- `tests/` — `node --test` suites; `tests/fixtures/base-AGENTS.md` is the
  base prompt the tool and authority rules are checked against.
- `index/logo.png` — the Agent Index logo (uploaded to the listing, not
  served from here).
- `checks/` — `manual-scenarios.md` (end-to-end checklist) and `spike.md`
  (findings from the base code and the owner's Mac).
- `Dockerfile`, `compose.yml`, `dev/Caddyfile` — the image and local stack.

## Development

Tests need no Plow credentials, no Mac and no network.

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

Node 24.16 or newer. The OpenClaw runtime (`2026.9.6`) comes from the base
image, pinned by digest (`1cf8e57e` in `Dockerfile`).

### Bumping the base image

Pick a newer `base-<sha>` tag and its digest from the
[gallery](https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents) and update the
`FROM` line in `Dockerfile`. Then:

1. Copy that commit's `prompt/AGENTS.md` over `tests/fixtures/base-AGENTS.md`.
2. Diff the new base prompt against the old fixture and carry any changed
   tool or authority rule into `prompt/AGENTS.md`; `tests/prompt.test.ts`
   fails on a rule the base rewords.
3. Copy that commit's `boot/main.ts` over `tests/fixtures/base-main.ts.txt`
   and carry any changed step into `boot/preboot.ts`; `tests/mcp.test.ts`
   fails on a base step preboot does not have. Drop `boot/mcp.ts` once the
   base sets the relay's `requestTimeoutMs` itself.
4. Re-check `compose.yml` and `dev/Caddyfile` against the base.
5. Run `npm test`.

## License

MIT. See [LICENSE](LICENSE).
