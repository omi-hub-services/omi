// Architect packet of `flow.ts prompt --architect` (OMI-165): the gate, the quality-round history
// and the role-driven step. Pure helpers plus one read of the task PR's comments; it never depends
// on a workflow `architect` step, only on the `architect` role file.
import { parse } from "yaml";
import { COORDINATOR_LOGIN, REPO_SLUG } from "./coordinator-settings.ts";
import { asArray, asObject, asString, optObject, optString, parseJson } from "./json-shape.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { runChecked, type Runner } from "./process-runner.ts";
import { parseStepMarkers } from "./worker-report.ts";

const PASS = /^\**VERDICT:\**\s*PASS\b/m;
const FAIL = /^\**VERDICT:\**\s*FAIL\b/m;
const ARCHITECT = /^\**ARCHITECT:\**[ \t]+\S/m;

/** Gate to render an Architect packet, and the FAIL verdicts that make up its history. */
export function architectGate(
  prComments: readonly AuthoredComment[],
  issueComments: readonly AuthoredComment[],
  round: number,
  coordinator: string = COORDINATOR_LOGIN,
): { readonly fails: readonly AuthoredComment[]; readonly refusal: string | null } {
  const own = (c: AuthoredComment) => c.author === coordinator;
  const passes = prComments.flatMap((c, i) => (own(c) && PASS.test(c.body) ? [i] : []));
  const since = prComments.slice((passes.at(-1) ?? -1) + 1);
  const fails = since.filter((c) => own(c) && FAIL.test(c.body));
  if (fails.length < 2) {
    return {
      fails,
      refusal: `--architect needs at least two Coordinator **VERDICT:** FAIL comments (account ${coordinator}) on the task PR since the last PASS, found ${String(fails.length)}`,
    };
  }
  const reported = parseStepMarkers(issueComments, coordinator).some(
    (p) => p.marker.step === "architect" && p.marker.round === round,
  );
  if (reported || since.some((c) => own(c) && ARCHITECT.test(c.body))) {
    return {
      fails,
      refusal: `an Architect packet already exists for round ${String(round)}; the Architect runs once per cycle`,
    };
  }
  return { fails, refusal: null };
}

/** Comments of the open PR of `branch`, oldest first; refuses when there is none. */
export async function readTaskPullComments(
  run: Runner,
  branch: string,
): Promise<readonly AuthoredComment[]> {
  const stdout = await runChecked(run, {
    file: "gh",
    args: [
      "pr",
      "list",
      "-R",
      REPO_SLUG,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "comments",
    ],
  });
  const pulls = asArray(parseJson(stdout, "gh pr list"), "prs");
  if (pulls.length !== 1) throw new Error(`--architect needs exactly one open PR for ${branch}`);
  return asArray(asObject(pulls[0], "pr").comments, "pr.comments").map((raw) => {
    const c = asObject(raw, "comment");
    return {
      author: optString(optObject(c.author, "comment.author")?.login, "comment.author.login"),
      body: asString(c.body, "comment.body"),
    };
  });
}

/** Skills and rules of the `architect` role; the mandatory rules ride along as for any packet. */
export function parseArchitectRole(yamlText: string): {
  readonly skills: readonly string[];
  readonly rules: readonly string[];
} {
  const role = asObject(parse(yamlText), "architect role");
  const ids = (key: string) => asArray(role[key], key).map((v) => asString(v, key));
  return {
    skills: ids("skills"),
    rules: [...new Set([...ids("rules"), "project-baseline", "approval-gates"])],
  };
}

export const ARCHITECT_INSTRUCTIONS = `## Architect task (read-only)

You are the Architect, a fresh independent run: no author or reviewer session is resumed. The task has failed review at least twice. Do not edit, create or delete any file, and do not patch the last findings. Read the history and the delta, find the defect classes behind the FAIL verdicts, and decide the simplest design that removes those classes, within the approved scope of the Issue. Prefer deleting code over adding it.

Output contract: step-result-v1. Put the decision in \`summary\` (limit 4000 characters; a longer summary is refused), in this order:
- Decision: what changes and what is deleted.
- Code changes: each with a file:line anchor.
- Required regression tests.
- AC-n assessment of the current head: one line per top-level AC, \`AC-n: met|not met — <evidence>\`.`;

export function renderHistory(fails: readonly AuthoredComment[]): string {
  return [
    "## Quality round history (Coordinator FAIL verdicts since the last PASS, oldest first)",
    ...fails.map((c, i) => `### FAIL ${String(i + 1)} of ${String(fails.length)}\n${c.body}`),
  ].join("\n\n");
}
