// OMI-006 — cleanup: removes what the probe created so the sandbox can be reused. Every step is
// idempotent (a 404 counts as "already gone") and runs even when an earlier one failed.
import { parseJsonOutput, pickArray, pickString, type ProbeSession } from "./probe-session.ts";

export interface CleanupOptions {
  readonly deleteIssues: boolean;
  readonly deleteFields: boolean;
}

export async function cleanupSandbox(
  session: ProbeSession,
  options: CleanupOptions,
): Promise<void> {
  const { state } = session;
  const repo = session.repo;
  const main = state.defaultBranch ?? "main";
  const step = (id: string, api: string, args: readonly string[], body?: unknown) =>
    session.step({
      id: `cleanup.${id}`,
      capability: "cleanup",
      api,
      args,
      body,
      expect: "success",
      allowNotFound: true,
    });

  for (const [key, run] of Object.entries(state.runs)) {
    const out = await session.gh(["api", `repos/${repo}/actions/runs/${String(run.id)}`]);
    if (pickString(parseJsonOutput(out.stdout), "status") === "completed") continue;
    await step(`run.${key}.cancel`, "gh run cancel", [
      "run",
      "cancel",
      String(run.id),
      "--repo",
      repo,
    ]);
  }
  for (const [key, pr] of Object.entries(state.prs)) {
    const out = await session.gh([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    if (pickString(parseJsonOutput(out.stdout), "state") !== "OPEN") continue;
    await step(`pr.${key}.close`, "gh pr close", [
      "pr",
      "close",
      String(pr.number),
      "--repo",
      repo,
    ]);
  }
  if (state.rulesetId !== null) {
    await step("ruleset.delete", "REST DELETE /repos/{r}/rulesets/{id}", [
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/rulesets/${String(state.rulesetId)}`,
    ]);
  }
  await step("environment.delete", "REST DELETE /repos/{r}/environments/{env}", [
    "api",
    "-X",
    "DELETE",
    `repos/${repo}/environments/${state.environmentName}`,
  ]);

  // Files this run put on the default branch: the workflow and the merged probe-check files.
  const files: string[] = [];
  if (state.workflowCommitted) files.push(`.github/workflows/${state.workflowFile}`);
  const listing = await session.gh(["api", `repos/${repo}/contents/probe-check?ref=${main}`]);
  for (const entry of pickArray(parseJsonOutput(listing.stdout), "")) {
    const path = pickString(entry, "path");
    if (path?.startsWith(`probe-check/${state.runId}-`) === true) files.push(path);
  }
  for (const path of files) {
    const out = await session.gh(["api", `repos/${repo}/contents/${path}?ref=${main}`]);
    const sha = pickString(parseJsonOutput(out.stdout), "sha");
    if (sha === undefined) continue;
    await step(
      `file.${path}.delete`,
      "REST DELETE /repos/{r}/contents/{path}",
      ["api", "-X", "DELETE", `repos/${repo}/contents/${path}`, "--input", "-"],
      {
        message: `chore: remove omi-006 probe file (${state.runId})`,
        sha,
        branch: main,
      },
    );
  }
  for (const branch of [...state.branches].reverse()) {
    await step(`branch.${branch}.delete`, "REST DELETE /repos/{r}/git/refs/heads/{branch}", [
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/git/refs/heads/${branch}`,
    ]);
  }
  for (const itemId of state.itemIds) {
    await step(`project.item.${itemId}.delete`, "gh project item-delete", [
      "project",
      "item-delete",
      String(state.projectNumber),
      "--owner",
      state.projectOwner,
      "--id",
      itemId,
    ]);
  }
  for (const [key, issue] of Object.entries(state.issues)) {
    if (options.deleteIssues) {
      await step(`issue.${key}.delete`, "gh issue delete --yes", [
        "issue",
        "delete",
        String(issue.number),
        "--repo",
        repo,
        "--yes",
      ]);
      continue;
    }
    const out = await session.gh([
      "issue",
      "view",
      String(issue.number),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    if (pickString(parseJsonOutput(out.stdout), "state") !== "OPEN") continue;
    await step(`issue.${key}.close`, 'gh issue close --reason "not planned"', [
      "issue",
      "close",
      String(issue.number),
      "--repo",
      repo,
      "--reason",
      "not planned",
    ]);
  }
  if (options.deleteFields) {
    for (const fieldId of state.createdFieldIds) {
      await step(`project.field.${fieldId}.delete`, "gh project field-delete", [
        "project",
        "field-delete",
        "--id",
        fieldId,
      ]);
    }
  }
  state.cleanedUpAt = new Date().toISOString();
  session.saveState();
}
