# Travel/movable preview integration

In preview bb147ce, reconcile these conflicts rather than retaining both rules:

- `skills/meetly-group/SKILL.md:76–77` says a busy requested time uses `--near` and offers immediately. Lines 159–161 also say “offer the nearest available times right away; do not ask … schedule over the conflict.” The permission question must end the inspection turn; historical answers must never trigger `remember` or an offer in that turn. Both bypass `meetly-travel:38–46`, which requires private movable inspection and fresh permission first in the owner's main DM. Group/guest requests still use alternatives without private inspection.
- The travel cross-reference at group lines 121–123 comes after the entire offer/delivery flow. Move it before search. Missing `travelBase` in the current setup output means ask privately and stop, even when setup is READY. Require explicit estimates on searches/offers; save the same estimate.
- The generic “changes → meetly-confirm” route swallows replies to travel notes. Route replies to the last private travel estimate to `meetly-travel` first; confirm must also redirect there before interpreting a number as meeting duration. Travel corrections use `calendar.ts travel`, not `book` or `duration`.
- Guest recovery must use tool descriptions (guests cannot read skills): await format updates, search once on `TIME_UNAVAILABLE`, then hand off `NO_ALTERNATIVES` through `meetly_ask_owner`. Preserve conditions and do not retry the failed pick. Carry the explicit estimate into the replacement search.

Required reads: new owner requests → group; in-person preparation or travel-note replies → travel; busy preferred owner-DM time → travel/movable before `--near`; booking changes/owner answers → confirm; email delivery → email; pipeline/asked requests → manage. Link each at its decision point, not after delivery. Preserve the inspect-first rule from feat/meetly-movable when merging the split skills. Never relay private bases or blocker titles to guests.

These branches split the formerly 4,553-word group skill by flow. Reconcile with preview's existing split instead of adding duplicate flows. Keep each skill below 2,000 words and AGENTS near 1,500 words/10k characters. Keep preview's explicit-duration work; do not restore meal-based duration overrides from the older branch.

Validation: six regression cases fail against ef47915 and pass with the changes; full suites pass (travel 532, movable 549). GLM 5.2 fixture replays used 95 calls against a cap of 96, with no live calendar/message execution. Final travel cases ask for the base, resize travel only, and hand exhausted alternatives to the owner. Movable now inspects and asks before offering, but the last replay sent the same permission question via `message` and final text. Routing now agrees with the base contract: send once with `message`, then `NO_REPLY`; that final wording has not been re-replayed. The fixture also accepted a malformed `slots --at` call with search filters and no travel; real code rejects it. The owner flow now spells out the exact check command and excludes search filters. QA must verify valid arguments, validation recovery and single delivery on the merged preview. Failed intermediate runs are retained at `notes/qa-evidence/travel-movable-fixes/` in the kitchen workspace.

## V4 follow-up

In v4, `meetly-group`, "Owner request", routes a named person without a handle to
`ledger.ts find --name` and then Contacts. That lookup excludes booked meetings.
The travel correction now stays in a self-contained booked-list → calendar travel
→ private result flow. Keep the group guard before its recipient lookup; replace
v4's existing Owner corrections section with this branch's version.

Replay overlays must preserve v4's explicit-duration code, pipeline split and
`meetly_offer_owner_dm` overlap grant. Apply only these targeted sections rather
than copying older feature-branch skills wholesale. Evidence and overlay recipe:
`notes/preview4-flow-fixes/` in the kitchen workspace. These are captured-image
fixture replays, not a rebuilt or deployed preview.
