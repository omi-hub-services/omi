// Pure part of `flow.ts commit-worker` (OMI-077): a Codex worker cannot commit, so the Coordinator
// commits for it, and only paths a task may change (never `.tmp/`, never `.claude/`).

export const STAGE_PATHS = ["src", "tests", "docs", "templates", "schemas"] as const;

export type CommitJudgement =
  { readonly kind: "commit" } | { readonly kind: "refuse"; readonly reason: string };

const allowed = (path: string) => STAGE_PATHS.some((dir) => path.startsWith(`${dir}/`));

/** `current` is the checked-out branch, `staged` the index after staging the allowed paths. */
export function judgeCommit(
  branch: string,
  current: string,
  staged: readonly string[],
): CommitJudgement {
  const refuse = (reason: string): CommitJudgement => ({ kind: "refuse", reason });
  if (current !== branch) return refuse(`the checkout is on "${current}", not on ${branch}`);
  if (staged.length === 0) {
    return refuse(`nothing to commit in ${STAGE_PATHS.join(", ")}`);
  }
  const outside = staged.filter((p) => !allowed(p));
  if (outside.length > 0) {
    return refuse(
      `the index holds paths outside ${STAGE_PATHS.join(", ")}: ${outside.join(", ")} (unstage them first)`,
    );
  }
  return { kind: "commit" };
}
