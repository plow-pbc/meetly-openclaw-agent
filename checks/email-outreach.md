# Email outreach: local validation

The Dockerfile retains the production base pin. That image predates merged base
PR #50 and gives non-owner email turns only `plow_send_email`: the integration
check fails at its guest-tool assertion. Shipping email requires the deferred
base-image upgrade containing that change.

With `plow-openclaw:email-guest-tools` substituted locally, both integration
scenarios pass through the real base channel, policy pipeline, email sender,
Meetly guest tools and calendar writer. Network access is disabled; Plow and
calendar services are fixtures and model choices are scripted. No live email
or live-model run was performed.

[Recorded fixture threads](email-outreach.html) show this run's messages. The
full unit suite and typecheck passed (563 tests). The two channel scenarios
verify confirmed and uncertain opener receipts, first-reply thread recovery,
booking by a CC assistant without inviting that assistant, invitation delivery,
release of unused holds, private owner questions and confirmed email answers.
The base emitted a nonfatal SQLite maintenance warning; both scenarios passed.

Two migration regressions failed before the fix: old text ledger records lack a
channel field. They must stay visible and accept replacement offers as text.
Email re-offers retain their channel when it is omitted by the caller.

Email tools require an active turn, so email links are delivered with booking,
not scheduled thread reminders. Owner inclusion by the actual mail service and
model adherence to routing instructions remain unverified.

## Reproduce

Build a local base containing the merged email guest-tool union, then:

```sh
sed 's|^FROM .*|FROM plow-openclaw:email-guest-tools|' Dockerfile \
  | docker build -f - -t meetly:email-local .
mkdir -p /tmp/meetly-email-validation
docker run --rm --user root --network none --entrypoint sh \
  -e MEETLY_EMAIL_REPORT=/evidence/email-flow.json \
  -v "$PWD:/work:ro" -v /tmp/meetly-email-validation:/evidence \
  meetly:email-local -c '
    mkdir -p /opt/plow/plugin/node_modules &&
    ln -sf /app /opt/plow/plugin/node_modules/openclaw &&
    cd /work && node --test checks/email-flow.test.ts'
```

The same command against the unchanged production base demonstrates its missing
email guest-tool capability. `email-flow.json` records both fixture scenarios.
