import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const failure of ["plugin", "model", "config"]) test(`boot requires plugin activation and tolerates only model failure (${failure})`, t => {
  const marker = `${failure.toUpperCase()}_FAILED`;
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
      export const renderConfig = () => ({tools:{alsoAllow:[]},channels:{plow:{threadTrust:'untrusted'}}});
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
        if (url.endsWith('/boot/gate.ts')) return {format:'module-typescript', source:
          readFileSync(new URL(url), 'utf8').replace(/export async function installGate[\\s\\S]*?\\n}/, ${JSON.stringify(`export async function installGate() { ${failure === 'plugin' ? `throw new Error('${marker}');` : ''} }`)}), shortCircuit:true};
        if (url.endsWith('/boot/llm.ts')) return {format:'module', source: ${JSON.stringify(`
          export const llmRoute = () => { ${failure === 'model' ? `throw new Error('${marker}');` : "return {route:{provider:'fixture',primary:'fixture',fallbacks:[]}};"} };
          export const applyRoute = x => x;
        `)}, shortCircuit:true};
        if (url === ${JSON.stringify(preboot)}) return {format:'module-typescript', source:
          readFileSync(new URL(url),'utf8').replaceAll('/var/lib/plow', ${JSON.stringify(dir)}).replace('/opt/plow/prompt/AGENTS.md', ${JSON.stringify(join(dir, 'prompt.md'))})
            .replace('createRequire("/opt/plow/package.json")("json5")', ${JSON.stringify(failure === 'config' ? `({parse: () => { throw new Error('${marker}'); }})` : 'JSON')}), shortCircuit:true};
        return next(url, context);
      }
    });
  `);
  writeFileSync(join(dir, "prompt.md"), "fixture");
  writeFileSync(join(dir, "openclaw.json"), "{}");
  const result = spawnSync(process.execPath, ["--import", hook, new URL(preboot).pathname], {
    env: { ...process.env, PLOW_API_BASE: "http://fixture.invalid" }, encoding: "utf8", timeout: 1_000,
  });
  assert.match(result.stderr, new RegExp(marker));
  if (failure === "plugin") {
    assert.doesNotMatch(result.stdout, /GATEWAY_STARTED/);
    assert.equal(result.status, 1);
  } else if (failure === "config") {
    assert.doesNotMatch(result.stdout, /GATEWAY_STARTED/);
    assert.match(result.stderr, /plow-boot: parked/);
    assert.equal((result.error as NodeJS.ErrnoException)?.code, "ETIMEDOUT");
  } else {
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "openclaw.json"), "utf8")).plugins?.entries?.meetly,
      { enabled: true, hooks: { allowConversationAccess: true } });
    assert.match(result.stderr, /llm config left as it was/);
    assert.match(result.stdout, /GATEWAY_STARTED/);
    assert.equal(result.status, 0);
  }
});
