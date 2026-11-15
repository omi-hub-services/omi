import { afterEach, expect, it, vi } from "vitest";
import { reviewCommentCommand } from "../../../../tools/coordinator/flow-workers.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const HEAD = "9d0fba0123456789012345678901234567890abc";
const FORK = "a".repeat(40);
const TIP = "b".repeat(40);
const target = { viaWslExe: false, distro: "d", repoDir: "/home/u/omi" };
const body = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD.slice(0, 7)}\`\nAC-1: met — tested`;
const evidence = (base: string) => ({
  base: { revision: base, command: ["npm", "test"], exitCode: 1 },
  head: { revision: HEAD, command: ["npm", "test"], exitCode: 0 },
});

afterEach(() => vi.restoreAllMocks());

/** `mergeBase` is what the faked git prints (null: `git merge-base` fails). */
async function comment(regressionEvidence: unknown, mergeBase: string | null) {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const seen: Command[] = [];
  const text = (c: Command) => c.args.at(-1) ?? "";
  const run: Runner = (c) => {
    seen.push(c);
    if (text(c).includes("git merge-base"))
      return Promise.resolve(
        mergeBase === null
          ? { code: 1, stdout: "", stderr: "bad object" }
          : { code: 0, stdout: `${mergeBase}\n`, stderr: "" },
      );
    return Promise.resolve({ code: 0, stdout: "minibox-claude-code\n", stderr: "" });
  };
  const code = await reviewCommentCommand(
    { run, target },
    {
      pr: 7,
      prState: "OPEN",
      prHead: HEAD,
      baseSha: TIP,
      checkStatus: "pass",
      issueBody: "## Acceptance criteria\n- [ ] works\n\n## Implementation map\n- docs/notes.md\n",
      workflow: "bugfix",
      securityRisk: false,
      regressionEvidence,
      body,
      dryRun: true,
    },
  );
  return { code, seen: seen.map((c) => c.args.at(-1) ?? "") };
}

it("accepts evidence recorded on the fork point after the base tip moved", async () => {
  expect((await comment(evidence(FORK), FORK)).code).toBe(0);
});

it("refuses evidence recorded on the moved tip, which is not the fork point", async () => {
  expect((await comment(evidence(TIP), FORK)).code).toBe(1);
});

it("refuses a bugfix PASS when the fork point cannot be established, with no fallback to the tip", async () => {
  expect((await comment(evidence(TIP), null)).code).toBe(1);
});

it("fetches the exact PR head and base oids before taking their merge base", async () => {
  const { seen } = await comment(evidence(FORK), FORK);
  const fetch = seen.find((c) => c.includes("git fetch"));
  const mergeBase = seen.find((c) => c.includes("git merge-base"));
  for (const c of [fetch, mergeBase]) {
    expect(c).toContain(HEAD);
    expect(c).toContain(TIP);
  }
});
