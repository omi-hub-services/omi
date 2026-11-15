// Explicit inventory of transitional policy copies (ADR-0036). A copy without evidence is a gate.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installCoordinatorSkills } from "./skill-installation.ts";

export const COPY_PARITY = [
  {
    repo: "tools/coordinator/pin-policy.ts",
    framework: "templates/prompts/coordinator-pin-guard.cjs",
    test: "tests/integration/tools/coordinator/pin-bootstrap.test.ts",
  },
  {
    repo: "tools/coordinator/review-verdict.ts",
    framework: "src/domain/delivery/acceptance-review.ts",
    test: "tests/unit/tools/coordinator/policy-parity.test.ts",
  },
  {
    repo: "tools/coordinator/effort-policy.ts",
    framework: "src/domain/agents/complexity-policy.ts",
    test: "tests/unit/tools/coordinator/effort-policy.test.ts",
  },
  {
    repo: "tools/coordinator/quota.ts",
    framework: "src/domain/profiles/quota-policy.ts",
    test: "tests/unit/tools/coordinator/policy-parity.test.ts",
  },
  {
    repo: "tools/coordinator/carried-pass.ts",
    framework: "src/domain/delivery/carried-pass-policy.ts",
    test: "tests/unit/tools/coordinator/policy-parity.test.ts",
  },
  {
    repo: "tools/coordinator/runs-retention.ts",
    framework: "src/domain/runs/log-retention-policy.ts",
    test: "tests/unit/tools/coordinator/policy-parity.test.ts",
  },
  {
    repo: "tools/coordinator/issue-spec.ts",
    framework: "src/domain/tasks/issue-spec-policy.ts",
    test: "tests/unit/tools/coordinator/policy-parity.test.ts",
  },
  {
    repo: "tools/coordinator/worker-report.ts",
    framework: "src/application/contracts/result.ts",
    test: "tests/unit/tools/coordinator/single-source.test.ts",
  },
] as const;

export async function checkCopyInventory(root: string): Promise<void> {
  for (const entry of COPY_PARITY) {
    await readFile(resolve(root, entry.repo));
    await readFile(resolve(root, entry.framework));
    const test = await readFile(resolve(root, entry.test), "utf8");
    for (const source of [entry.repo, entry.framework]) {
      if (!test.includes(source))
        throw new Error(
          `PARITY_EVIDENCE_MISSING: ${entry.repo}: ${entry.test} must exercise ${source}`,
        );
    }
  }
}

if (import.meta.main) {
  const root = resolve(".");
  await checkCopyInventory(root);
  const drift = await installCoordinatorSkills(root, false);
  if (drift.length)
    throw new Error(
      `COORDINATOR_SKILL_DRIFT: ${drift.join(", ")}; Coordinator runs node tools/coordinator/skill-installation.ts install --apply`,
    );
  console.log("Coordinator template drift and copy inventory checks passed");
}
