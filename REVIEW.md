# Review instructions — meetly-openclaw-agent

Repo-specific reviewer policy. The universal voice posture (Broken-Glass,
pro-simplification, and the don't-propose list) is supplied by the reviewers
themselves and is deliberately not restated here.

## What this repo is

**One agent**: Meetly, a scheduling assistant that reads the owner's
iMessages through Latch, asks the owner about whoever wants to meet, opens a
Plow group once they say yes, and books the meeting on the owner's Google
Calendar. It is the prompt
(`prompt/AGENTS.md`), the `meetly-*` skills and their scripts, a setup-gate
plugin, and a boot that runs on a pinned base. The runtime underneath
(OpenClaw, boot, identity, the Plow channel) is `plow-pbc/plow-openclaw-agent`.
`README.md` owns the product prose and this file does not repeat it. Flag
drift between that prose and the code, in either direction.

**Stage:** pre-PMF, early. A handful of installs, each one owner's assistant
running against their own Plow line. It writes to that owner's calendar and
talks to people the owner has never vouched for, so a credential, a chat id,
a phone number, an email or a real person's calendar data anywhere in the
tracked tree is blocking. That includes `tests/fixtures/`.

## Review priority

Subtractive remedies outrank additive ones. Four gates here can be checked
directly, and they come ahead of anything else:

- **Guests cannot widen what Meetly does.** New groups are untrusted
  (`PLOW_THREAD_TRUST=untrusted`): guests receive only scoped scheduling
  tools bound to their saved request and exact chat. Scripts enforce the
  owner's conditions and keep calendar event names and details private.
  Only the owner may authorize conflicts or out-of-hours times. Review the
  tool grants, request authorization and calendar checks; block a guest
  path that widens those grants or supplies its own overlap authorization.
- **Deterministic work lives in scripts, not the model.** Reading the
  calendar, matching contacts, the ledger state and the poll cursor already
  moved into `skills/meetly/scripts/` (#31, #32). Flag new logic that has a
  single correct answer and is placed in a skill's prose instead.
- **Calendar writes are owned and reversible.** A hold expires after 48 hours,
  and booking releases the other holds. Block a write path that leaves a
  hold or a ledger row with no way out. Meetly never sends from the owner's own Messages account.
- **Pins are the supply chain.** The base `FROM` carries a digest. Binaries
  fetched at build carry a version and a sha256. Block a move to a mutable
  ref. Bumping a pin to a new immutable revision is ordinary work, not a
  finding.

**Repo-specific contrast pairs:**

| Variant DON'T (suppress / flag-as-shape) | Variant DO (real finding) |
|---|---|
| Flag a behaviour for being **specific to scheduling one owner's meetings**. Being that one assistant is the reason this repo exists. Generality here is bloat, not a fix. | Flag a change that a **sibling repo owns**. `boot/` follows the base's boot step for step: a fix to boot, identity, the Plow channel or the agentsview collector goes to `plow-openclaw-agent`, and this repo keeps in step with it rather than forking further. Calendar, contacts and iMessage access go through Latch's tools and the gog grammar. A wrapper that re-implements one of them is a finding. Account, login, mint and revoke belong to `plow-agents`. The test: who else would have to change if this fact changed? |

**Update cadence:** edit this when the stage changes. Product and architecture
edits belong in `README.md`, not here.
