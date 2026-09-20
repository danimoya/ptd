/**
 * Which card this checkout is working on.
 *
 * The same convention the Claude Code hook pack uses, so a repository can be
 * labelled once and both the hook and `ptd agent-run` book their time against
 * the same card: `$PTD_TASK`, else the first line of a `.ptd-task` file at or
 * above the working directory. The value is a task id when it is all digits and
 * an `externalKey` (SEC-3) otherwise — exactly what `ptd start` already accepts.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const TASK_FILE = ".ptd-task";

export interface RepoTask {
  ref: string;
  from: "env" | "file";
  path?: string;
}

export function repoTask(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): RepoTask | null {
  const fromEnv = env.PTD_TASK?.trim();
  if (fromEnv) return { ref: fromEnv, from: "env" };

  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const path = resolve(dir, TASK_FILE);
    try {
      const ref = readFileSync(path, "utf8").split(/\r?\n/)[0]?.trim();
      if (ref) return { ref, from: "file", path };
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
