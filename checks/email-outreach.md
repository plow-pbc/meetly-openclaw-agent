# Email outreach: local validation

Implemented on `feat/meetly-email`, directly above `d63ff31`.
Local base: `plow-openclaw:email-guest-tools`, built from base PR #50 commit
`667e3e772a9773167be1b69e7f0ff293f73764ee`.

[Rendered fixture threads](email-outreach.html) show the email conversation and
private owner messages. These are recorded fixture sends with scripted model
choices, not a live model or Gmail run. No live mail, Latch calls, push or deploy.

## Results

- In-image typecheck passed; all 417 tests passed.
- Both in-image integration scenarios passed through the real base channel,
  context builder, policy pipeline, `plow_send_email`, shipped Meetly guest tools,
  and calendar writer. Plow and calendar network responses were fixtures, and
  Docker ran with `--network none`.
- An owner email request created three holds before sending the opener.
  A CC'd assistant selected Tuesday; Ana received the calendar invitation,
  the assistant was not added, two unused holds were released, and the
  confirmation went to the same email thread.
- An uncertain opener retained its start attempt, refused an automatic restart,
  and linked on the CC reply using the authenticated server roster.
- An unanswerable guest question produced only an owner DM. The owner's answer
  used the base email tool and cleared the pending item after its confirmed receipt.
- Unit tests cover alternative times, decline, explicitly requested extra
  invitees, channel/thread isolation, invalid or ambiguous recovery rosters,
  time approval handoffs and answer receipts. The empty optional attendee-list
  regression was observed red before fixing it, then passed in the full suite.

## Limits and implementation choices

The production Dockerfile pin is unchanged; publishing this feature requires a
base containing the email guest-tool union. The local build substitutes only
its `FROM` image.

The base requires an active Plow turn for email sends, so scheduled email
reminders cannot use its standard tool. Email Meet links are delivered with the
booking confirmation and invitation instead of a later reminder. Unattended
email expiry or cleanup notices go only to the owner. This differs from the
existing text reminder flow.

New outreach is limited to the owner's main DM or own email turn. Base email
finals can return to an originating trusted phone group, so starting outreach
there would not give the private owner handoff required here.

No live or model validation was run, as directed. Actual owner inclusion by the
Plow mail service and model adherence to the new instructions remain unverified.
The host emitted a nonfatal SQLite automatic-maintenance warning during an
integration run; both scenarios and their delivery assertions passed.

## Reproduce locally

Build the base PR #50 branch as `plow-openclaw:email-guest-tools`, then from this
Meetly worktree:

```sh
npm ci --ignore-scripts
sed 's|^FROM .*|FROM plow-openclaw:email-guest-tools|' Dockerfile \
  | docker build -f - -t meetly:email-local .
mkdir -p /tmp/meetly-email-validation
docker run --rm --user root --network none \
  -e MEETLY_EMAIL_REPORT=/evidence/email-flow.json \
  -v "$PWD:/work:ro" -v /tmp/meetly-email-validation:/evidence \
  meetly:email-local sh -c '
    mkdir -p /opt/plow/plugin/node_modules &&
    ln -s /app /opt/plow/plugin/node_modules/openclaw &&
    cd /work && node_modules/.bin/tsc --noEmit && npm test &&
    node --test checks/email-flow.test.ts'
```

`email-flow.json` contains the two recorded fixture conversations, booking
receipts, released-hold counts, and exposed guest-tool names.
