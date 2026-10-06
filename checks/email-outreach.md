# Email outreach: local validation

The pinned production base includes email guest-tool support. All four integration
scenarios pass through its real channel, policy pipeline, email sender,
Meetly guest tools and calendar writer. Network access is disabled; Plow and
calendar services are fixtures and model choices are scripted. No live email
or live-model run was performed.

[Recorded fixture threads](email-outreach.html) show this run's messages. The four channel scenarios
verify confirmed, uncertain, refused and lost-transport opener receipts, rejection
of unlinked threads even when their participants match,
booking by a CC assistant without inviting that assistant, invitation delivery,
release of unused holds, awaited private owner questions, suppressed finals and
confirmed email answers. Definite failures release all three holds; uncertain
receipts remain reserved and unlinked without repeating the opener.
The base emitted a nonfatal SQLite maintenance warning; both scenarios passed.

Two migration regressions failed before the fix: old text ledger records lack a
channel field. They must stay visible and accept replacement offers as text.
Email re-offers retain their channel when it is omitted by the caller.

Email tools require an active turn, so email links are delivered with booking,
not scheduled thread reminders. Owner inclusion by the actual mail service and
model adherence to routing instructions remain unverified.

## Reproduce

Build and run against the pinned base:

```sh
docker build -t meetly:email-local .
mkdir -p /tmp/meetly-email-validation
docker run --rm --user root --network none --entrypoint sh \
  -e MEETLY_EMAIL_REPORT=/evidence/email-flow.json \
  -v "$PWD:/work:ro" -v /tmp/meetly-email-validation:/evidence \
  meetly:email-local -c '
    mkdir -p /opt/plow/plugin/node_modules &&
    ln -sf /app /opt/plow/plugin/node_modules/openclaw &&
    cd /work && node --test checks/email-flow.test.ts'
```

`email-flow.json` records both fixture scenarios.
