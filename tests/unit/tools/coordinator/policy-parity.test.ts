// Characterization of transitional copies: transport units differ, policy decisions must agree.
import { expect, it } from "vitest";
import { judgeCarriedHead as productCarry } from "../../../../src/domain/delivery/carried-pass-policy.ts";
import { judgeCarriedHead as repoCarry } from "../../../../tools/coordinator/carried-pass.ts";
import { planLogRetention } from "../../../../src/domain/runs/log-retention-policy.ts";
import { planRetention } from "../../../../tools/coordinator/runs-retention.ts";
import {
  evaluateQuota,
  compareQuotaStanding,
} from "../../../../src/domain/profiles/quota-policy.ts";
import {
  evaluate,
  rankCandidates,
  parseClaudeUsage,
  parseCodexRateLimits,
  parseClaudeRateLimitEvent,
  type QuotaReading,
} from "../../../../tools/coordinator/quota.ts";
import {
  parseClaudeUsage as productUsage,
  parseClaudeRateLimitEvent as productEvent,
} from "../../../../src/infrastructure/executors/claude-code/claude-code-quota.ts";
import { parseCodexRateLimits as productCodex } from "../../../../src/infrastructure/executors/codex/codex-quota.ts";
import {
  QUOTA_SETTINGS,
  RUNS_RETENTION,
} from "../../../../tools/coordinator/coordinator-settings.ts";

const msWindow = (w: { usedPercent: number; resetsAt: number | null } | null) =>
  w === null ? null : { ...w, resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000 };
const productReading = (r: QuotaReading) => ({
  source: r.source === "claude-log" ? ("claude-probe" as const) : r.source,
  observedAt: r.observedAt * 1000,
  fiveHour: msWindow(r.fiveHour),
  sevenDay: msWindow(r.sevenDay),
  status: r.status,
  limited: r.limited,
  resetCredits: r.resetCredits,
  modelWindows: r.modelWindows.map((w) => ({
    model: w.model,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000,
  })),
});

it("keeps carried PASS decisions aligned for clean and invalid Git facts", () => {
  const facts = {
    head: "c".repeat(40),
    parents: ["a".repeat(40), "b".repeat(40)],
    secondParentOnDevelop: true,
    headTree: "d".repeat(40),
    mergeTree: "d".repeat(40),
  };
  for (const over of [
    {},
    { parents: [] },
    { parents: ["e".repeat(40), "b".repeat(40)] },
    { secondParentOnDevelop: false },
    { mergeTree: null },
    { headTree: "f".repeat(40) },
  ]) {
    const f = { ...facts, ...over };
    expect(repoCarry(f, "a".repeat(40)).ok).toBe(
      productCarry({ ...f, secondParentOnBase: f.secondParentOnDevelop }, "a".repeat(40)).ok,
    );
  }
});

it("keeps common retention decisions aligned across seconds and milliseconds", () => {
  const root = [
    { name: "omi-001-p-20260101-000000.jsonl", size: 5, mtime: 100, live: false },
    { name: "omi-001-p-20260102-000000.jsonl", size: 5, mtime: 200, live: false },
    { name: "omi-001-output.md", size: 5, mtime: 200, live: true },
    { name: "omi-002-output.md", size: 5, mtime: 200, live: false },
    { name: "omi-001-recent.md", size: 5, mtime: 9999, live: false },
  ];
  const archive = [
    { name: "old.gz", size: 100, mtime: 0, live: false },
    { name: "large.gz", size: 100, mtime: 9000, live: false },
  ];
  const settings = { ...RUNS_RETENTION, archiveMaxAgeDays: 0.1, archiveMaxBytes: 10 };
  const repo = planRetention({ now: 10000, root, archive }, new Set(["001"]), settings);
  const product = planLogRetention(
    {
      now: 10000000,
      root: root.map((f) => ({
        ...f,
        taskId: f.name.startsWith("omi-001") ? "001" : "002",
        profile: f.name.endsWith(".jsonl") ? "p" : null,
        mtimeMs: f.mtime * 1000,
        running: f.live,
      })),
      archive: archive.map((f) => ({ ...f, mtimeMs: f.mtime * 1000 })),
    },
    new Set(["001"]),
    settings,
  );
  expect(repo.map(({ name, action }) => ({ name, action }))).toEqual(
    product.map(({ name, action }) => ({ name, action })),
  );
});

it("keeps quota thresholds, staleness, limits, scores and ranking aligned", () => {
  const now = 10000;
  for (const usedPercent of [0, 89.9, 90, 90.1, 100])
    for (const resetsAt of [null, 9999, 10001])
      for (const limited of [false, true])
        for (const sharesCoordinatorAccount of [false, true])
          for (const observedAt of [0, 10000]) {
            const reading: QuotaReading = {
              source: "claude-probe",
              observedAt,
              fiveHour: { usedPercent, resetsAt },
              sevenDay: { usedPercent: 1, resetsAt },
              limited,
              status: limited ? "rejected" : "allowed",
              resetCredits: null,
              planType: null,
              modelWindows: [],
            };
            const q = {
              tool: "claude" as const,
              profile: "p",
              sharesCoordinatorAccount,
              reading,
              note: null,
            };
            const repo = evaluate(q, QUOTA_SETTINGS, now, true);
            const product = evaluateQuota(
              { profileId: "p", sharesCoordinatorAccount, reading: productReading(reading) },
              {
                ...QUOTA_SETTINGS,
                coordinatorSharedPolicy: "penalize",
                staleAfterMs: QUOTA_SETTINGS.staleAfterMinutes * 60000,
              },
              now * 1000,
            );
            expect({
              left: repo.fiveHourLeft,
              weekly: repo.sevenDayLeft,
              freshness: repo.freshness,
              score: repo.score,
              blocked: repo.blocked !== null,
              until: repo.blockedUntil === null ? null : repo.blockedUntil * 1000,
            }).toEqual({
              left: product.fiveHourLeft,
              weekly: product.sevenDayLeft,
              freshness: product.freshness,
              score: product.score,
              blocked: product.blocked.length > 0,
              until: product.blockedUntil,
            });
            const better = { ...repo, profile: "other", score: (repo.score ?? 0) + 1 };
            expect(rankCandidates([repo, better])[0]?.profile).toBe(
              compareQuotaStanding(product, { ...product, score: better.score }) > 0
                ? "other"
                : "p",
            );
          }
});

it("keeps secret-free quota parsers aligned after transport adaptation", () => {
  const usage = {
    five_hour: { utilization: 25.12, resets_at: "2026-11-12T00:00:00Z" },
    seven_day: null,
    limits: [{ kind: "weekly_scoped", model: "Opus", percent: 30, resets_at: null }],
  };
  expect(productReading(parseClaudeUsage(usage, 100))).toEqual(
    productUsage(
      {
        ...usage,
        limits: usage.limits.map((w) => ({ ...w, scope: { model: { display_name: w.model } } })),
      },
      100000,
    ),
  );
  const codex = {
    rateLimits: { primary: { usedPercent: 20, resetsAt: 200 }, secondary: null },
    rateLimitResetCredits: { availableCount: 2 },
  };
  expect(productReading(parseCodexRateLimits(codex, 100))).toEqual(productCodex(codex, 100000));
  const event = {
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 200 } },
    },
  };
  expect(productReading(parseClaudeRateLimitEvent(event, 100, "claude-probe"))).toEqual(
    productEvent(event, 100000),
  );
});

it("keeps Issue spec and Plan Key allocation aligned", async () => {
  const repo = await import("../../../../tools/coordinator/issue-spec.ts");
  const product = await import("../../../../src/domain/tasks/issue-spec-policy.ts");
  const keys = await import("../../../../src/domain/tasks/plan-key.ts");
  const frontmatter =
    "---\ntitle: Example\npriority: P1\nworkType: Task\nworkflow: feature\nrole: Developer\narea: tooling\nmilestone: M1\nepic: 1\nblockedBy: []\n---\n";
  const valid =
    "## Mục tiêu\nGoal\n## Phạm vi\nScope\n## Acceptance criteria\n- [ ] measurable\n## Dependencies\nNone\n## Framework counterpart\nsrc/domain/tasks/issue-spec-policy.ts";
  for (const body of [
    valid,
    "empty",
    valid.replace("## Framework counterpart", "## Other"),
    valid.replace("- [ ] measurable", "nested\n  - [ ] ignored"),
  ]) {
    expect(repo.parseIssueSpec(frontmatter + body).kind === "ok").toBe(
      product.issueSpecBodyReasons(body, "Task", "OMI", "tooling").length === 0,
    );
  }
  for (const allocated of [[], ["OMI-001", "APP-999", null], ["OMI-099", "OMI-002"]])
    expect(repo.nextPlanKey(allocated)).toBe(keys.nextPlanKey("OMI", allocated));
});

it("keeps review presentation decisions aligned on canonical full-head comments", async () => {
  const { checkReview } = await import("../../../../tools/coordinator/review-verdict.ts");
  const { reviewCommentRefusals } =
    await import("../../../../src/domain/delivery/acceptance-review.ts");
  const head = "a".repeat(40);
  const header = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\``;
  for (const body of [
    `${header}\nAC-1: met — evidence`,
    `${header}\nAC-1: met – evidence`,
    `${header}\nAC-1: met - evidence`,
    `${header}\nAC-1: met -- evidence`,
    `${header}\nAC-1: met`,
    `${header}\nAC-1: not met — missing`,
    `${header.replace("PASS", "FAIL")}\nAC-1: not met — missing`,
    `${header}\nAC-1: met — evidence\nAC-1: met — duplicate`,
    `${header}\nAC-2: met — unknown`,
    `${header}\n${header}\nAC-1: met — evidence`,
    `${header.replace(head, "b".repeat(40))}\nAC-1: met — evidence`,
  ])
    expect(checkReview(body, { acCount: 1, prHead: head }).ok).toBe(
      reviewCommentRefusals(body, head, 1).length === 0,
    );
});
