// Registers Meetly's cron jobs idempotently (a port of The Founder Times'
// register_crons.py). Creates missing jobs, edits drifted ones in place,
// removes meetly-* jobs outside the spec, and never touches a job without
// the meetly- prefix. Never remove-then-create: a failed create would leave
// Meetly with no poll.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { cronBackend, type CronBackend, type CronJob, type JobSpec } from "./cron-backend.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

// A command job: no model call unless poll.ts finds work and wakes a turn.
export const POLL_ARGV = ["node", "/opt/plow/skills/meetly/scripts/poll.ts"];

export const SPEC: JobSpec[] = [
  { name: "meetly-poll", every: "5m", everyMs: 300_000, timeoutSeconds: 120, argv: POLL_ARGV },
];

const PREFIX = "meetly-";

export type Action = { op: "create" | "edit" | "enable" | "disable" | "remove"; name: string; id?: string };

// Drift is judged only on fields the scheduler reported; a missing field is
// left alone rather than edited on a guess.
function drifted(job: CronJob, spec: JobSpec): boolean {
  const { schedule, payload } = job;
  if (schedule?.kind !== undefined && schedule.kind !== "every") return true;
  if (schedule?.everyMs !== undefined && schedule.everyMs !== spec.everyMs) return true;
  if (payload?.kind !== undefined && payload.kind !== "command") return true;
  if (payload?.argv !== undefined && JSON.stringify(payload.argv) !== JSON.stringify(spec.argv)) return true;
  if (payload?.timeoutSeconds !== undefined && payload.timeoutSeconds !== spec.timeoutSeconds) return true;
  if (job.sessionTarget !== undefined && job.sessionTarget !== "isolated") return true;
  return false;
}

export function plan(jobs: CronJob[], spec: JobSpec[], paused: boolean): Action[] {
  const actions: Action[] = [];
  const ours = jobs.filter((j) => j.name.startsWith(PREFIX));
  for (const s of spec) {
    const [first, ...dupes] = ours.filter((j) => j.name === s.name);
    if (!first) {
      actions.push({ op: "create", name: s.name });
      continue;
    }
    if (drifted(first, s)) actions.push({ op: "edit", name: s.name, id: first.id });
    if ((first.enabled ?? true) !== !paused) {
      actions.push({ op: paused ? "disable" : "enable", name: s.name, id: first.id });
    }
    for (const d of dupes) actions.push({ op: "remove", name: d.name, id: d.id });
  }
  const names = new Set(spec.map((s) => s.name));
  for (const j of ours) {
    if (!names.has(j.name)) actions.push({ op: "remove", name: j.name, id: j.id });
  }
  return actions;
}

export function reconcile(backend: CronBackend, paused: boolean, spec: JobSpec[] = SPEC): Action[] {
  const actions = plan(backend.list(), spec, paused);
  const byName = new Map(spec.map((s) => [s.name, s]));
  for (const a of actions) {
    if (a.op === "create") backend.create(byName.get(a.name)!, !paused);
    else if (a.op === "edit") backend.edit(a.id!, byName.get(a.name)!);
    else if (a.op === "enable" || a.op === "disable") backend.setEnabled(a.id!, a.op === "enable");
    else backend.remove(a.id!);
  }
  return actions;
}

type StoredConfig = { setupDoneAt?: string; paused?: boolean };

export function registerFromConfig(
  backend: CronBackend = cronBackend(),
  set?: { paused: boolean },
): { paused: boolean; actions: Action[] } {
  const path = file("config.json");
  const config = readJson<StoredConfig | null>(path, null);
  if (!config?.setupDoneAt) throw new Error("setup is not finished; run the setup first");
  let paused = config.paused === true;
  if (set) {
    updateJson<StoredConfig>(path, {}, (c) => ({ ...c, paused: set.paused }));
    paused = set.paused;
  }
  return { paused, actions: reconcile(backend, paused) };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({ options: { pause: { type: "boolean" }, resume: { type: "boolean" }, "if-ready": { type: "boolean" } } });
    if (values.pause && values.resume) throw new Error("pass --pause or --resume, not both");
    if (values["if-ready"] && !readJson<StoredConfig | null>(file("config.json"), null)?.setupDoneAt) return { skipped: "not-ready" };
    const set = values.pause ? { paused: true } : values.resume ? { paused: false } : undefined;
    return registerFromConfig(cronBackend(), set);
  });
}
