import { afterEach, expect, it, vi } from "vitest";
import { reviewCommentCommand } from "../../../../tools/coordinator/flow-workers.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const HEAD = "9d0fba0123456789012345678901234567890abc";
const target = { viaWslExe: false, distro: "d", repoDir: "/home/u/omi" };
const verdict = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${HEAD.slice(0, 7)}\`\nAC-1: met — tested`;

afterEach(() => vi.restoreAllMocks());

/** `meta` is what ~/omi-runs holds for the task's review packets. */
async function comment(body: string, meta: readonly object[]) {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const seen: Command[] = [];
  const run: Runner = (c) => {
    seen.push(c);
    const payload = c.args.at(-1) ?? "";
    const stdout = payload.includes("-meta-review-")
      ? meta.map((m) => `${JSON.stringify(m)}\n`).join("")
      : "minibox-claude-code\n";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  const code = await reviewCommentCommand(
    { run, target },
    {
      pr: 7,
      prState: "OPEN",
      prHead: HEAD,
      checkStatus: "pass",
      issueBody: "## Acceptance criteria\n- [ ] works\n\n## Implementation map\n- docs/notes.md\n",
      workflow: "feature",
      securityRisk: false,
      planKey: "OMI-340",
      body,
      dryRun: true,
    },
  );
  return { code, error: err.mock.calls.flat().join(" ") };
}

it("refuses a verdict without Security: when the packet dispatched with --risk security recorded it, though review-comment got no flag", async () => {
  const recorded = { securityReview: true, head: HEAD };
  const refused = await comment(verdict, [recorded]);
  expect(refused.code).toBe(1);
  expect(refused.error).toContain("Security:");
  const section = `${verdict}\nSecurity:\n- Secrets: checked — no token in the diff`;
  expect((await comment(section, [recorded])).code).toBe(0);
});

it("ignores metadata of another head, a packet without the marker, and a worker's own claim in the text", async () => {
  expect((await comment(verdict, [{ securityReview: true, head: "c".repeat(40) }])).code).toBe(0);
  expect((await comment(verdict, [{ head: HEAD }])).code).toBe(0);
  expect((await comment(verdict, [])).code).toBe(0);
});
