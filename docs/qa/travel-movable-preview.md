# Travel/movable preview integration

In preview bb147ce, reconcile these conflicts rather than retaining both rules:

- `skills/meetly-group/SKILL.md:76–77` says a busy requested time uses `--near` and offers immediately. Lines 159–161 also say “offer the nearest available times right away; do not ask … schedule over the conflict.” Both bypass `meetly-travel:38–46`, which requires private movable inspection and fresh permission first in the owner's main DM. Group/guest requests still use alternatives without private inspection.
- The travel cross-reference at group lines 121–123 comes after the entire offer/delivery flow. Move it before search. Missing `travelBase` in the current setup output means ask privately and stop, even when setup is READY. Require explicit estimates on searches/offers; save the same estimate.
- The generic “changes → meetly-confirm” route swallows replies to travel notes. Route replies to the last private travel estimate to `meetly-travel` first; confirm must also redirect there before interpreting a number as meeting duration. Travel corrections use `calendar.ts travel`, not `book` or `duration`.
- Guest recovery must use tool descriptions (guests cannot read skills): await format updates, search once on `TIME_UNAVAILABLE`, then hand off `NO_ALTERNATIVES` through `meetly_ask_owner`. Preserve conditions and do not retry the failed pick. Carry the explicit estimate into the replacement search.

Required reads: new owner requests → group; in-person preparation or travel-note replies → travel; busy preferred owner-DM time → travel/movable before `--near`; booking changes/owner answers → confirm; email delivery → email; pipeline/asked requests → manage. Link each at its decision point, not after delivery. Preserve the inspect-first rule from feat/meetly-movable when merging the split skills. Never relay private bases or blocker titles to guests.

These branches split the formerly 4,553-word group skill by flow. Reconcile with preview's existing split instead of adding duplicate flows. Keep each skill below 2,000 words and AGENTS near 1,500 words/10k characters. Keep preview's explicit-duration work; do not restore meal-based duration overrides from the older branch.
