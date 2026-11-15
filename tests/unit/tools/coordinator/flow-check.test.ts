import { describe, expect, it } from "vitest";
import { checkWithReuse } from "../../../../tools/coordinator/flow-check.ts";
import type { Plan } from "../../../../tools/coordinator/flow-plans.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const target = { viaWslExe: false, distro: "d", repoDir: "/repo" };
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const run: Plan = { kind: "run", steps: [{ side: "wsl", argv: ["npm", "run", "check"] }] };

function rig(outcomes: boolean[]) {
  const files = new Map<string, string>();
  const runner: Runner = (c: Command) => {
    const payload = c.args.at(-1) ?? "";
    const file = /checks\/([A-Za-z0-9.-]+\.json)/.exec(payload)?.[1] ?? "";
    if (payload.startsWith("cat ")) {
      const text = files.get(file);
      return Promise.resolve({ code: text === undefined ? 1 : 0, stdout: text ?? "", stderr: "" });
    }
    files.set(file, c.input ?? "");
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const executed: Plan[] = [];
  const exec = (plan: Plan, out: string[]): Promise<boolean> => {
    executed.push(plan);
    if (plan.kind !== "run") return Promise.resolve(plan.kind === "done");
    out.push("check output line");
    return Promise.resolve(outcomes.shift() ?? true);
  };
  const check = (plan: Plan, head: string, dryRun = false) =>
    checkWithReuse({ run: runner, target, exec, dryRun }, plan, head);
  const ran = () => executed.filter((p) => p.kind === "run").length;
  return { check, executed, ran, files };
}

describe("checkWithReuse", () => {
  it("runs the check once and reuses the passed result for the same head", async () => {
    const r = rig([true]);
    expect(await r.check(run, HEAD)).toBe(true);
    expect(await r.check(run, HEAD)).toBe(true);
    expect(r.ran()).toBe(1);
    expect(r.executed.at(-1)).toEqual({ kind: "done", note: `reused ${HEAD.slice(0, 7)}` });
  });

  it("runs again for a different head", async () => {
    const r = rig([true, true]);
    await r.check(run, HEAD);
    await r.check(run, OTHER);
    expect(r.ran()).toBe(2);
  });

  it("never reuses a failed result and replaces it by the next run", async () => {
    const r = rig([false, true]);
    expect(await r.check(run, HEAD)).toBe(false);
    expect(await r.check(run, HEAD)).toBe(true);
    expect(r.ran()).toBe(2);
    expect(await r.check(run, HEAD)).toBe(true);
    expect(r.ran()).toBe(2);
  });

  it("passes a refusal through without reading or storing anything", async () => {
    const r = rig([]);
    const refuse: Plan = { kind: "refuse", reason: "dirty" };
    expect(await r.check(refuse, HEAD)).toBe(false);
    expect(r.files.size).toBe(0);
  });

  it("stores nothing on a dry run and keeps the output as the stored log", async () => {
    const dry = rig([true]);
    await dry.check(run, HEAD, true);
    expect(dry.files.size).toBe(0);
    const wet = rig([true]);
    await wet.check(run, HEAD);
    expect([...wet.files.values()][0]).toContain("check output line");
  });
});
