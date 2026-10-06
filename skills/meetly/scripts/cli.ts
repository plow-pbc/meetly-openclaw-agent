import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// True when the module at importMetaUrl is the script node was started with.
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(resolve(entry)).href;
}

// Every CLI prints one JSON line on success, or `error: <message>` on stderr
// with a non-zero exit code, never a partial result.
export function run(fn: () => unknown | Promise<unknown>, present: (result: unknown) => unknown = result => result): void {
  const fail = (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  };
  try {
    Promise.resolve(fn()).then(present).then((result) => {
      if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
    }, fail);
  } catch (err) {
    fail(err);
  }
}

// The contents of the given files, or of stdin when there are none.
export function readInput(paths: string[] = []): string[] {
  if (paths.length === 0) return [readFileSync(0, "utf8")];
  return paths.map((p) => readFileSync(p, "utf8"));
}
