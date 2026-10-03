// Meetly's entrypoint: the base's boot (boot/main.ts at the pinned base, kept
// in tests/fixtures/base-main.ts.txt), step for step, on the base's own
// compiled modules, with Meetly's additions made before the config is synced:
//
//  - the Mac relay's request timeout (mcp.ts), in the config the base renders,
//    which the base rewrites on every boot and nothing after it could change;
//  - the model (llm.ts) and the setup gate (gate.ts), in agents.defaults and
//    plugins.entries, the part of openclaw.json the base leaves to the owner.
//
// The scheduling plugin is required: installation must succeed before boot.
// The base's steps fail exactly as the base's boot does.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { applyGate, installGate } from "./gate.ts";
import { applyRoute, llmRoute } from "./llm.ts";
import { withMacTimeout } from "./mcp.ts";

const CONFIG = "/var/lib/plow/openclaw.json";
const INCLUDES = "/etc/plow/openclaw";
// Loaded by path at run time: these are the base image's compiled modules.
const load = (path: string) => import(path);

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Do not start a gateway that advertises guest tools it cannot provide.
await installGate().catch(error => { throw new Error(`meetly-boot: required plugin install failed: ${message(error)}`); });

try {
  const { installBootLog } = await load("/opt/plow/boot/log.js");
  const { startAgentIndex } = await load("/opt/plow/boot/agent-index.js");
  const { renderConfig, syncConfig } = await load("/opt/plow/boot/config.js");
  const { identityFromApi } = await load("/opt/plow/boot/identity.js");
  const { renderPrompt } = await load("/opt/plow/boot/prompt.js");
  const { startGateway } = await load("/opt/plow/boot/process.js");

  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  const config = withMacTimeout(renderConfig(identity, base));
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
  await chmod("/var/lib/plow/gateway-password", 0o600);
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN, config.channels.plow.threadTrust, identity.agent?.web_url));

  const JSON5 = createRequire("/opt/plow/package.json")("json5");
  let owner: Record<string, unknown>;
  try {
    owner = JSON5.parse(await readFile(CONFIG, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A fresh volume starts with the base config.
    owner = structuredClone(config);
  }
  try {
    const { route, problem } = llmRoute();
    if (problem) console.error(`meetly-boot: llm: ${problem}`);
    owner = applyRoute(structuredClone(owner), route, base);
    console.log(`meetly-boot: llm ${route.provider} ${route.primary}${route.fallbacks.length ? ` (fallback ${route.fallbacks.join(", ")})` : ""}`);
  } catch (error) {
    console.error(`meetly-boot: llm config left as it was: ${message(error)}`);
  }
  applyGate(owner);
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
  await rename(`${CONFIG}.tmp`, CONFIG);

  await syncConfig(config, CONFIG, INCLUDES);
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex(300_000, writeLog);
  await startGateway(false, identity.mcp_url ?? undefined, writeLog);
} catch (error) {
  console.error(`plow-boot: parked: ${message(error)}`);
  setInterval(() => {}, 2 ** 30);
}
