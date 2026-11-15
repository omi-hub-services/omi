// Read-only gh calls shared by the status and flow scripts.
import { BASE_BRANCH, OWNER, PROJECT_NUMBER, REPO, REPO_SLUG } from "./coordinator-settings.ts";
import {
  parseSnapshotPage,
  SNAPSHOT_QUERY,
  type OpenPull,
  type ProjectItem,
} from "./github-snapshot.ts";
import {
  asArray,
  asObject,
  asString,
  graphqlData,
  parseJson,
  type JsonObject,
} from "./json-shape.ts";
import { runChecked, type Runner } from "./process-runner.ts";

/** Every Project item (all pages) plus the open PRs; shared by status and `flow.ts promote`. */
export async function readProject(run: Runner) {
  const items: ProjectItem[] = [];
  let pulls: readonly OpenPull[] = [];
  let title: string;
  let after: string | null = null;
  do {
    const page = parseSnapshotPage(
      await graphql(run, SNAPSHOT_QUERY, {
        owner: OWNER,
        repo: REPO,
        project: PROJECT_NUMBER,
        after,
        withPulls: after === null,
      }),
    );
    title = page.projectTitle;
    items.push(...page.items);
    if (page.pulls) pulls = page.pulls;
    after = page.nextCursor;
  } while (after !== null);
  return { title, items, pulls };
}

/** GraphQL request on stdin, so no query text or variable ends up on a command line. */
export async function graphql(
  run: Runner,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<JsonObject> {
  const stdout = await runChecked(run, {
    file: "gh",
    args: ["api", "graphql", "--input", "-"],
    input: JSON.stringify({ query, variables }),
  });
  return graphqlData(stdout, "gh api graphql");
}

export function parseRequiredChecks(rules: unknown): string[] {
  return asArray(rules, "rules").flatMap((raw) => {
    const rule = asObject(raw, "rule");
    if (rule.type !== "required_status_checks") return [];
    const checks = asObject(rule.parameters, "rule.parameters").required_status_checks;
    return asArray(checks, "required_status_checks").map((c) =>
      asString(asObject(c, "check").context, "check.context"),
    );
  });
}

/** Required status checks of the base branch rulesets, read live (never hard-coded). */
export async function readRequiredChecks(run: Runner): Promise<string[]> {
  const stdout = await runChecked(run, {
    file: "gh",
    args: ["api", `repos/${REPO_SLUG}/rules/branches/${BASE_BRANCH}`],
  });
  return parseRequiredChecks(parseJson(stdout, "rules"));
}
