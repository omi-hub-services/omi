import { expect, it, vi } from "vitest";
import { WORKER_PROFILES } from "../../../../tools/coordinator/coordinator-settings.ts";
import { dispatchCommand } from "../../../../tools/coordinator/flow-workers.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const PACKET = `<!-- omi-quality {"policy":"task-default","step":"implement","steps":["implement"],"round":1} -->\n# x`;

it("dispatch records tool, profile, model, effort, step, round and head for the signed report (OMI-159)", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const seen: Command[] = [];
  const run: Runner = (c) => {
    seen.push(c);
    const payload = c.args.at(-1) ?? "";
    const stdout =
      payload.includes("rev-parse") && !payload.includes("claude")
        ? `${"b".repeat(40)}\n`
        : "exit=0\n";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  const profile = WORKER_PROFILES.find((p) => p.tool === "claude");
  expect(profile).toBeDefined();
  const code = await dispatchCommand(
    { run, target: { viaWslExe: false, distro: "d", repoDir: "/home/u/omi" } },
    {
      planKey: "OMI-159",
      role: null,
      workflow: "feature",
      complexity: "high",
      kind: "claude",
      profile: profile?.profile ?? "",
      resume: null,
      prompt: PACKET,
      dryRun: false,
    },
  );
  expect(code).toBe(0);
  const write = seen.find((c) => (c.args.at(-1) ?? "").includes("-meta-"));
  const meta = JSON.parse(write?.input ?? "{}") as Record<string, unknown>;
  expect(meta).toMatchObject({
    task: "159",
    tool: "claude",
    profile: profile?.profile,
    step: "implement",
    round: 1,
    head: "b".repeat(40),
  });
  expect(String(meta.packet)).toMatch(/^implement-1-[a-z0-9]+$/);
  expect(typeof meta.model).toBe("string");
  expect(typeof meta.effort).toBe("string");
});
