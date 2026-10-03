import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a required plugin install failure stops boot before the gateway starts", t => {
  const dir = mkdtempSync(join(tmpdir(), "meetly-boot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preboot = new URL("../boot/preboot.ts", import.meta.url).href;
  const hook = join(dir, "hook.mjs");
  writeFileSync(hook, `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    const fakeBase = 'data:text/javascript,' + encodeURIComponent(\`
      export const installBootLog = () => () => {};
      export const startAgentIndex = () => {};
      export const renderConfig = () => ({channels:{plow:{threadTrust:'untrusted'}}});
      export const syncConfig = async () => {};
      export const identityFromApi = async () => ({line:{uid:'fixture'}});
      export const renderPrompt = async () => '';
      export const startGateway = async () => { console.log('GATEWAY_STARTED'); };
    \`);
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith('/opt/plow/boot/')) return {url:fakeBase, shortCircuit:true};
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.endsWith('/boot/gate.ts')) return {format:'module', source:
          'export const installGate = async () => { throw new Error("PLUGIN_COPY_FAILED"); }; export const applyGate = x => x;', shortCircuit:true};
        if (url === ${JSON.stringify(preboot)}) return {format:'module-typescript', source:
          readFileSync(new URL(url),'utf8').replaceAll('/var/lib/plow', ${JSON.stringify(dir)}).replace('/opt/plow/prompt/AGENTS.md', ${JSON.stringify(join(dir, 'prompt.md'))}), shortCircuit:true};
        return next(url, context);
      }
    });
  `);
  writeFileSync(join(dir, "prompt.md"), "fixture");
  const result = spawnSync(process.execPath, ["--import", hook, new URL(preboot).pathname], {
    env: { ...process.env, PLOW_API_BASE: "http://fixture.invalid" }, encoding: "utf8", timeout: 5_000,
  });
  assert.match(result.stderr, /PLUGIN_COPY_FAILED/);
  assert.doesNotMatch(result.stdout, /GATEWAY_STARTED/);
  assert.equal(result.status, 1);
});
