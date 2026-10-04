import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAC_REQUEST_TIMEOUT_MS, withMacTimeout } from "../boot/mcp.ts";

test("the Mac relay gets a request timeout, so its tool listing is not capped at 1500 ms", () => {
  const config = withMacTimeout({ mcp: { sessionIdleTtlMs: 300_000, servers: { plow: { url: "http://127.0.0.1:18790/mcp" } } } });
  assert.equal(config.mcp.servers.plow.requestTimeoutMs, MAC_REQUEST_TIMEOUT_MS);
  assert.equal(MAC_REQUEST_TIMEOUT_MS, 60_000);
});

test("a timeout the base sets is kept, and a config without the relay is left alone", () => {
  assert.equal(withMacTimeout({ mcp: { servers: { plow: { requestTimeoutMs: 5000 } } } }).mcp.servers.plow.requestTimeoutMs, 5000);
  assert.deepEqual(withMacTimeout({ mcp: { sessionIdleTtlMs: 1 } }), { mcp: { sessionIdleTtlMs: 1 } });
});

// preboot.ts is the base's boot step for step. A base bump replaces the
// fixture with that commit's boot/main.ts; a step preboot does not carry fails here.
test("preboot carries every step of the pinned base's boot", () => {
  const root = join(import.meta.dirname, "..");
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const preboot = flat(readFileSync(join(root, "boot", "preboot.ts"), "utf8"));
  const base = readFileSync(join(root, "tests", "fixtures", "base-main.ts.txt"), "utf8");
  // The base steps customized for Meetly, and what they have instead.
  const changed: Record<string, string> = {
    "const config = renderConfig(identity, base);": "const config = withMacTimeout(renderConfig(identity, base));",
    'await syncConfig(config, "/var/lib/plow/openclaw.json", "/etc/plow/openclaw");': "await syncConfig(config, CONFIG, INCLUDES);",
  };
  const steps = base.split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("import ") && !l.startsWith("//") && !["try {", "}", "} catch (error) {"].includes(l));
  assert.ok(steps.length > 15, "fixture looks empty");
  for (const step of steps) {
    const expected = changed[step] ?? step.replace("error instanceof Error ? error.message : String(error)", "message(error)")
      .replace("renderPrompt(prompt,", "renderPrompt(namedPrompt,");
    assert.ok(preboot.includes(flat(expected)), `preboot is missing the base step: ${step}`);
  }
  for (const module of ["log", "agent-index", "config", "identity", "prompt", "process"]) {
    assert.ok(preboot.includes(`/opt/plow/boot/${module}.js`), module);
  }
});
