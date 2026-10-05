// The scheduler register-crons.ts writes to: OpenClaw's own cron service,
// through `node /app/openclaw.mjs cron ...` inside the running container
// (exec inherits the gateway token, so no token is ever an argument).
//
// `cron list` hides disabled jobs, so listing always passes --all, and the
// listing pages with hasMore. Never read "could not tell what is registered"
// as "nothing is": a failed command, non-JSON, a wrong shape or a truncated
// page throws, or every job would be registered twice.
import { spawnSync } from "node:child_process";

export type Proc = { status: number; stdout: string; stderr: string };
export type Runner = (argv: string[]) => Proc;

export type CronJob = {
  id: string;
  name: string;
  enabled?: boolean;
  sessionTarget?: string;
  schedule?: { kind?: string; everyMs?: number };
  payload?: { kind?: string; argv?: string[]; timeoutSeconds?: number };
};

export type JobSpec = { name: string; every: string; everyMs: number; timeoutSeconds: number; argv: string[] };

export type CronBackend = {
  list(): CronJob[];
  create(spec: JobSpec, enabled: boolean): void;
  edit(id: string, spec: JobSpec): void;
  setEnabled(id: string, enabled: boolean): void;
  remove(id: string): void;
};

export const spawnRunner: Runner = (argv) => {
  const proc = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 120_000 });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr || (proc.error ? String(proc.error) : ""),
  };
};

function refuse(what: string): never {
  throw new Error(`refusing to touch the scheduler: ${what}`);
}

export function cronBackend(runner: Runner = spawnRunner, base: string[] = ["node", "/app/openclaw.mjs"]): CronBackend {
  const cron = (args: string[]): Proc => {
    const argv = [...base, "cron", ...args];
    const proc = runner(argv);
    if (proc.status !== 0) {
      throw new Error(`cron ${args[0]} failed (exit ${proc.status}):\n${proc.stdout}\n${proc.stderr}`);
    }
    return proc;
  };
  const job = (spec: JobSpec) => [
    "--every", spec.every,
    "--session", "isolated",
    "--command-argv", JSON.stringify(spec.argv),
    "--timeout-seconds", String(spec.timeoutSeconds),
    "--no-deliver",
  ];
  return {
    list() {
      const proc = runner([...base, "cron", "list", "--all", "--json"]);
      if (proc.status !== 0) refuse(`could not list jobs (exit ${proc.status}):\n${proc.stdout}\n${proc.stderr}`);
      let listing: unknown;
      try {
        listing = JSON.parse(proc.stdout);
      } catch {
        refuse(`the job listing is not JSON: ${proc.stdout.slice(0, 200)}`);
      }
      const rows = (listing as { jobs?: unknown } | null)?.jobs;
      const valid = Array.isArray(rows) && rows.every(
        (r) => r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string",
      );
      if (!valid) refuse(`the job listing has an unexpected shape: ${proc.stdout.slice(0, 200)}`);
      if ((listing as { hasMore?: unknown }).hasMore) refuse("the job listing is truncated (hasMore)");
      return rows as CronJob[];
    },
    create(spec, enabled) {
      cron(["add", "--name", spec.name, ...job(spec), ...(enabled ? [] : ["--disabled"]), "--json"]);
    },
    edit(id, spec) {
      cron(["edit", id, ...job(spec)]);
    },
    setEnabled(id, enabled) {
      cron(["edit", id, enabled ? "--enable" : "--disable"]);
    },
    remove(id) {
      cron(["rm", id, "--json"]);
    },
  };
}
