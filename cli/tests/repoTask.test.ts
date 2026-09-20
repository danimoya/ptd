/** Which card a checkout is labelled with: $PTD_TASK, then a .ptd-task file up the tree. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoTask, TASK_FILE } from "../src/repoTask.ts";

function tree(): { root: string; deep: string } {
  const root = mkdtempSync(join(tmpdir(), "ptd-repo-"));
  const deep = join(root, "packages", "web", "src");
  mkdirSync(deep, { recursive: true });
  return { root, deep };
}

describe("repoTask", () => {
  it("prefers $PTD_TASK over any file", () => {
    const { root, deep } = tree();
    writeFileSync(join(root, TASK_FILE), "SEC-3\n");
    expect(repoTask(deep, { PTD_TASK: " API-9 " } as NodeJS.ProcessEnv)).toEqual({ ref: "API-9", from: "env" });
  });

  it("walks up from the working directory to find the file", () => {
    const { root, deep } = tree();
    writeFileSync(join(root, TASK_FILE), "SEC-3\n");
    const found = repoTask(deep, {} as NodeJS.ProcessEnv);
    expect(found?.ref).toBe("SEC-3");
    expect(found?.from).toBe("file");
    expect(found?.path).toBe(join(root, TASK_FILE));
  });

  it("takes the nearest file when several exist", () => {
    const { root, deep } = tree();
    writeFileSync(join(root, TASK_FILE), "SEC-3\n");
    writeFileSync(join(root, "packages", "web", TASK_FILE), "WEB-1\n");
    expect(repoTask(deep, {} as NodeJS.ProcessEnv)?.ref).toBe("WEB-1");
  });

  it("reads only the first line and trims it, so a commented file still works", () => {
    const { root } = tree();
    writeFileSync(join(root, TASK_FILE), "  SEC-3  \n# the CSRF card\n");
    expect(repoTask(root, {} as NodeJS.ProcessEnv)?.ref).toBe("SEC-3");
  });

  it("ignores an empty label", () => {
    const { root } = tree();
    writeFileSync(join(root, TASK_FILE), "\n\n");
    expect(repoTask(root, { PTD_TASK: "   " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null when nothing labels the checkout", () => {
    const { deep } = tree();
    expect(repoTask(deep, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});
