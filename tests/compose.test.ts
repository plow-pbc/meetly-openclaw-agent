import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

test("Meetly binds its dashboard to a configurable loopback host port and restarts unless stopped", () => {
  const compose = readFileSync(join(ROOT, "compose.yml"), "utf8");
  const agent = compose.match(/  agent:\n([\s\S]*?)(?=\n  dev-dashboard:)/)?.[1];
  assert.ok(agent, "compose.yml has an agent service");
  assert.match(agent, /- "127\.0\.0\.1:\$\{HOST_PORT:-3001\}:3001"/);
  assert.match(agent, /restart: unless-stopped/);
});

test("dashboard documentation identifies the default and configurable host port", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /By default,[\s\S]*?dashboard is at <http:\/\/localhost:3001>/);
  assert.match(readme, /Set `HOST_PORT` to bind another loopback port/);
});

test("new groups are untrusted and grant exactly the registered guest tools", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const env = dockerfile.match(/^ENV [\s\S]*?(?=\n\S)/m)?.[0] ?? "";
  assert.match(env, /PLOW_THREAD_TRUST=untrusted/);
  const names = env.match(/PLOW_GUEST_TOOLS=(\S+)/)?.[1]?.split(",");
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugin", "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(names, manifest.contracts.tools.filter((name: string) => !["meetly_answer_owner", "meetly_offer_owner_group", "meetly_offer_owner_dm", "meetly_contact_preference", "meetly_confirm_contact", "meetly_edit_attendee", "meetly_change_format", "meetly_change_travel"].includes(name)));
  assert.ok(!names?.includes("meetly_answer_owner"));
  assert.equal(new Set(names).size, 6);
});
