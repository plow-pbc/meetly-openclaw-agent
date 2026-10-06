import { test } from "node:test";
import assert from "node:assert/strict";
import { cronBackend, type CronJob, type Proc } from "../skills/meetly/scripts/cron-backend.ts";
import { plan, POLL_ARGV, reconcile, registerFromConfig, SPEC } from "../skills/meetly/scripts/register-crons.ts";
import { readJson, writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";
import { join } from "node:path";

const poll = (over: Partial<CronJob> = {}): CronJob => ({
  id: "j1",
  name: "meetly-poll",
  enabled: true,
  sessionTarget: "isolated",
  schedule: { kind: "every", everyMs: 300_000 },
  payload: { kind: "command", argv: POLL_ARGV, timeoutSeconds: 120 },
  ...over,
});

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// A scheduler in memory that understands the argv cron-backend sends.
function fakeScheduler(initial: CronJob[] = []) {
  const jobs: CronJob[] = initial.map((j) => structuredClone(j));
  const calls: string[][] = [];
  let next = 100;
  const runner = (argv: string[]): Proc => {
    calls.push(argv);
    const [, , , op, ...rest] = argv;
    const ok = (out: unknown = {}): Proc => ({ status: 0, stdout: JSON.stringify(out), stderr: "" });
    if (op === "list") return ok({ jobs, hasMore: false });
    if (op === "add") {
      const job: CronJob = {
        id: `j${next++}`,
        name: flag(rest, "--name")!,
        enabled: !rest.includes("--disabled"),
        sessionTarget: flag(rest, "--session"),
        schedule: { kind: "every", everyMs: flag(rest, "--every") === "5m" ? 300_000 : 0 },
        payload: { kind: "command", argv: JSON.parse(flag(rest, "--command-argv")!), timeoutSeconds: Number(flag(rest, "--timeout-seconds")) },
      };
      jobs.push(job);
      return ok(job);
    }
    const job = jobs.find((j) => j.id === rest[0]);
    if (!job) return { status: 1, stdout: "", stderr: "no such job" };
    if (op === "rm") {
      jobs.splice(jobs.indexOf(job), 1);
      return ok();
    }
    if (op === "edit") {
      if (rest.includes("--enable")) job.enabled = true;
      if (rest.includes("--disable")) job.enabled = false;
      if (flag(rest, "--command-argv")) {
        job.payload = { kind: "command", argv: JSON.parse(flag(rest, "--command-argv")!), timeoutSeconds: Number(flag(rest, "--timeout-seconds")) };
        job.schedule = { kind: "every", everyMs: 300_000 };
        job.sessionTarget = flag(rest, "--session");
      }
      return ok(job);
    }
    return { status: 2, stdout: "", stderr: `unknown ${op}` };
  };
  return { jobs, calls, runner };
}

test("the poll is one command job that runs poll.ts", () => {
  assert.deepEqual(SPEC.map((s) => s.name), ["meetly-poll"]);
  assert.deepEqual(POLL_ARGV, ["node", "/opt/plow/skills/meetly/scripts/poll.ts"]);
});

test("plan: empty creates, exact match does nothing", () => {
  assert.deepEqual(plan([], SPEC, false), [{ op: "create", name: "meetly-poll" }]);
  assert.deepEqual(plan([poll()], SPEC, false), []);
});

test("plan: drift is judged only on reported fields", () => {
  assert.deepEqual(plan([poll({ payload: { argv: ["node", "old.ts"] } })], SPEC, false), [{ op: "edit", name: "meetly-poll", id: "j1" }]);
  // The agent-turn poll of earlier images becomes the command job in place.
  assert.deepEqual(plan([poll({ payload: { kind: "agentTurn", timeoutSeconds: 600 } })], SPEC, false), [{ op: "edit", name: "meetly-poll", id: "j1" }]);
  assert.deepEqual(plan([poll({ schedule: { kind: "every", everyMs: 60_000 } })], SPEC, false)[0]?.op, "edit");
  assert.deepEqual(plan([poll({ schedule: { kind: "cron" } })], SPEC, false)[0]?.op, "edit");
  assert.deepEqual(plan([poll({ sessionTarget: "main" })], SPEC, false)[0]?.op, "edit");
  assert.deepEqual(plan([poll({ payload: { kind: "command", argv: POLL_ARGV, timeoutSeconds: 30 } })], SPEC, false)[0]?.op, "edit");
  const bare: CronJob = { id: "j1", name: "meetly-poll", enabled: true };
  assert.deepEqual(plan([bare], SPEC, false), []);
});

test("plan: paused disables, resumed enables", () => {
  assert.deepEqual(plan([poll()], SPEC, true), [{ op: "disable", name: "meetly-poll", id: "j1" }]);
  assert.deepEqual(plan([poll({ enabled: false })], SPEC, false), [{ op: "enable", name: "meetly-poll", id: "j1" }]);
});

test("plan: foreign jobs are ignored, orphans and duplicates removed", () => {
  const heartbeat: CronJob = { id: "h", name: "heartbeat", enabled: true };
  assert.deepEqual(plan([poll(), heartbeat], SPEC, false), []);
  assert.deepEqual(plan([poll(), { id: "o", name: "meetly-old" }], SPEC, false), [{ op: "remove", name: "meetly-old", id: "o" }]);
  assert.deepEqual(plan([poll(), poll({ id: "j2" })], SPEC, false), [{ op: "remove", name: "meetly-poll", id: "j2" }]);
});

test("list refuses anything it cannot read fully", () => {
  const backend = (proc: Proc) => cronBackend(() => proc);
  const refuse = (err: Error) => err.message.startsWith("refusing to touch the scheduler:");
  assert.throws(() => backend({ status: 1, stdout: "", stderr: "down" }).list(), refuse);
  assert.throws(() => backend({ status: 0, stdout: "nope", stderr: "" }).list(), refuse);
  assert.throws(() => backend({ status: 0, stdout: '{"jobs":{}}', stderr: "" }).list(), refuse);
  assert.throws(() => backend({ status: 0, stdout: '{"jobs":[{"id":1,"name":"x"}]}', stderr: "" }).list(), refuse);
  assert.throws(() => backend({ status: 0, stdout: '{"jobs":[],"hasMore":true}', stderr: "" }).list(), refuse);
  assert.deepEqual(backend({ status: 0, stdout: '{"jobs":[]}', stderr: "" }).list(), []);
});

test("create sends the expected argv and no model", () => {
  const s = fakeScheduler();
  reconcile(cronBackend(s.runner), false);
  const add = s.calls.find((c) => c[3] === "add")!;
  assert.deepEqual(add.slice(0, 4), ["node", "/app/openclaw.mjs", "cron", "add"]);
  const text = add.join(" ");
  assert.ok(text.includes("--every 5m --session isolated"));
  assert.ok(add.includes("--no-deliver"));
  assert.equal(flag(add, "--timeout-seconds"), "120");
  assert.deepEqual(JSON.parse(flag(add, "--command-argv")!), POLL_ARGV);
  assert.ok(!add.includes("--message"));
  assert.ok(!add.includes("--model"));
  assert.ok(!add.includes("--disabled"));
});

test("a failing command throws with its output", () => {
  const backend = cronBackend(() => ({ status: 3, stdout: "out", stderr: "err" }));
  assert.throws(() => backend.remove("x"), /out[\s\S]*err/);
});

test("create while paused registers the job disabled", () => {
  const s = fakeScheduler();
  assert.deepEqual(reconcile(cronBackend(s.runner), true), [{ op: "create", name: "meetly-poll" }]);
  assert.equal(s.jobs[0]!.enabled, false);
});

function withHome(fn: (home: string) => void) {
  const saved = process.env.MEETLY_HOME;
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  try {
    fn(home);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
}

test("registerFromConfig creates, is idempotent, pauses and resumes", () => {
  withHome((home) => {
    const config = join(home, "config.json");
    writeJson(config, { ownerName: "Jean", setupDoneAt: "2026-09-26T12:00:00Z" });
    const s = fakeScheduler([{ id: "h", name: "heartbeat", enabled: true }]);
    const backend = cronBackend(s.runner);
    assert.deepEqual(registerFromConfig(backend).actions, [{ op: "create", name: "meetly-poll" }]);
    assert.deepEqual(registerFromConfig(backend), { paused: false, actions: [] });
    const paused = registerFromConfig(backend, { paused: true });
    assert.equal(paused.paused, true);
    assert.equal(paused.actions[0]?.op, "disable");
    assert.equal(readJson<{ paused?: boolean }>(config, {}).paused, true);
    assert.equal(s.jobs.find((j) => j.name === "meetly-poll")!.enabled, false);
    assert.deepEqual(registerFromConfig(backend).actions, []);
    assert.equal(registerFromConfig(backend, { paused: false }).actions[0]?.op, "enable");
    assert.equal(readJson<{ paused?: boolean }>(config, {}).paused, false);
    assert.ok(s.jobs.some((j) => j.name === "heartbeat"));
  });
});

test("registerFromConfig refuses before setup and writes nothing", () => {
  withHome((home) => {
    const s = fakeScheduler();
    assert.throws(() => registerFromConfig(cronBackend(s.runner), { paused: true }), /setup is not finished/);
    writeJson(join(home, "config.json"), { ownerName: "Jean" });
    assert.throws(() => registerFromConfig(cronBackend(s.runner), { paused: true }), /setup is not finished/);
    assert.equal(readJson<{ paused?: boolean }>(join(home, "config.json"), {}).paused, undefined);
    assert.equal(s.calls.length, 0);
  });
});

test("startup registration skips an install whose setup is incomplete", () => {
  withHome(home => {
    for (const configured of [false, true]) {
      if (configured) writeJson(join(home, "config.json"), { ownerName: "Jean" });
      const result = cli("register-crons.ts", ["--if-ready"], { MEETLY_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { skipped: "not-ready" });
    }
  });
});
