# Calendar create reconciliation

Verified on 2026-10-03 through the local QA stack's prod-Latch forwarder,
using real `plow-gog` (gog v0.36.0, eaa5d631).

The create command exposes no caller-chosen event-ID flag. It does accept
`--private-prop meetlyOperation=<unique token>`. Listing `primary` with
`--private-prop-filter meetlyOperation=<same token>`, `--from`, `--to`,
`--all-pages` and `--json` returned exactly the event created with that
property. Its private property survived the round trip. The lookup did not
use the create response's event ID.

The single five-minute test event used the QA-coordinated window, no attendees,
and `--send-updates none`. It was deleted by its recovered ID with `--force`
and read back as `cancelled`. Raw evidence stays in the kitchen's
`notes/calendar-seam-spike/result.json`, outside the repository.

Use a unique private-property token persisted before each create. After an
ambiguous write, search that event's time window for the token and reconcile
the returned ID. An empty search does not prove that a delayed create failed:
keep the operation unresolved rather than issue another create. Updates and
deletes already have a known event ID and can be read back by that ID.
