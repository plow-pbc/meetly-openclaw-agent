import { cp, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

// Meetly's scheduling and setup gate plugin (plugin/). The base owns plugins.load, so the
// plugin sits in the state volume's global plugin root, where OpenClaw
// discovers it. The image holds the real copy, root-owned; preboot replaces
// the volume's copy on every boot, so an edit made there does not survive a
// restart.
export const GATE_SOURCE = "/opt/meetly/plugin";
export const GATE_ROOT = "/var/lib/plow/extensions/meetly";

export async function installGate(source = GATE_SOURCE, target = GATE_ROOT): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

/** Enables the plugin; OpenClaw runs a non-bundled plugin's conversation hooks only with this opt-in. */
export function applyGate(config: Record<string, any>): Record<string, any> {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries.meetly = { enabled: true, hooks: { allowConversationAccess: true } };
  return config;
}
