// OMI-006 — PoC: live GitHub capability probe against a sandbox repository and Project.
// Opt-in, never part of `npm run check` or CI (no *.test.ts file here). The phases run as
// different GitHub actors and share a state file; every gh call is recorded in the evidence file.
// See docs/architecture/adr/0015-github-capability-matrix.md and `--help`-style USAGE below.
//
//   setup   (author)   Project/Issue probes, workflow, environment, ruleset, PRs, pre-approval gates
//   approve (approver) approve PRs and the gated deployment; prevent_self_review attempt
//   verify  (author)   merges after approval/green, link effects, deployment state
//   cleanup (any)      remove what the run created
//   matrix  (no gh)    print the capability matrix from an evidence file
import { existsSync } from "node:fs";
import { release } from "node:os";
import { cleanupSandbox } from "./cleanup-probes.ts";
import {
  approvePullRequests,
  commitWorkflow,
  createPullRequests,
  createRuleset,
  probeGatesBeforeApproval,
  probeLinkage,
  verifyPullRequests,
} from "./delivery-probes.ts";
import {
  approveDeployment,
  createEnvironment,
  dispatchGatedRun,
  readPendingDeployments,
  verifyDeployments,
} from "./deployment-probes.ts";
import {
  buildMatrixRows,
  type Phase,
  parseProbeArgs,
  parseTokenScopes,
  type ProbeArgs,
  renderMatrixMarkdown,
  type StepResult,
  unknownCapabilities,
} from "./probe-model.ts";
import { probeIssues, probeProject } from "./project-issue-probes.ts";
import {
  errorMessage,
  loadOrCreateEvidence,
  loadState,
  newState,
  parseJsonOutput,
  pick,
  pickNumber,
  pickString,
  ProbeSession,
  type ProbeState,
  readEvidence,
  runGh,
} from "./probe-session.ts";

function runId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Who is calling, with which scopes and tools; recorded at the start of every phase. */
async function preflight(session: ProbeSession): Promise<string> {
  const user = await session.gh(["api", "user"]);
  const login = pickString(parseJsonOutput(user.stdout), "login");
  if (user.code !== 0 || login === undefined) {
    throw new Error(`gh api user failed; is gh logged in? ${user.stderr.trim()}`);
  }
  const version = await runGh(["--version"], undefined, 30_000);
  session.startPhase(login, {
    gh: version.stdout.split(/\r?\n/)[0] ?? null,
    node: process.version,
    platform: `${process.platform} ${release()}`,
  });
  await session.step({
    id: `env.actor.${session.phase}.user`,
    capability: "env.actor",
    api: "REST GET /user",
    args: ["api", "user"],
    expect: "success",
    observe: (stdout) => ({ login: pickString(parseJsonOutput(stdout), "login") ?? null }),
  });
  // Only the scope list is kept; the (masked) token line never reaches the evidence.
  const auth = await session.gh(["auth", "status", "--active", "--hostname", "github.com"]);
  const scopes = parseTokenScopes(`${auth.stdout}\n${auth.stderr}`);
  session.observe({
    id: `env.actor.${session.phase}.scopes`,
    capability: "env.actor",
    api: "gh auth status --active (scopes only)",
    command: "gh auth status --active --hostname github.com",
    result: auth.code === 0 && scopes !== null ? "supported" : "partial",
    detail: scopes === null ? "no scope line (fine-grained token or gh output changed)" : "",
    observed: { scopes: scopes?.join(",") ?? null },
  });
  return login;
}

async function setupPhase(session: ProbeSession): Promise<void> {
  const { state } = session;
  const login = await preflight(session);
  if (login.toLowerCase() === state.approver.toLowerCase()) {
    throw new Error(`setup must run as the PR author, not the approver ${state.approver}`);
  }
  state.author = login;
  session.saveState();

  const repo = await session.step({
    id: "env.actor.repo",
    capability: "env.actor",
    api: "REST GET /repos/{r}",
    args: ["api", `repos/${session.repo}`],
    expect: "success",
    observe: (stdout) => {
      const data = parseJsonOutput(stdout);
      return {
        visibility: pickString(data, "visibility") ?? null,
        defaultBranch: pickString(data, "default_branch") ?? null,
        admin: pickBoolean(data, "permissions.admin"),
        push: pickBoolean(data, "permissions.push"),
        allowMergeCommit: pickBoolean(data, "allow_merge_commit"),
      };
    },
  });
  state.defaultBranch = pickString(parseJsonOutput(repo.stdout), "default_branch") ?? null;
  if (!repo.ok || state.defaultBranch === null)
    throw new Error("sandbox repository could not be read");
  await session.step({
    id: "env.actor.org-plan",
    capability: "env.actor",
    api: "REST GET /orgs/{org} (plan visible to owners only)",
    args: ["api", `orgs/${session.repo.split("/")[0] ?? ""}`],
    expect: "success",
    observe: (stdout) => ({ plan: pickString(parseJsonOutput(stdout), "plan.name") ?? null }),
  });
  const approver = await session.step({
    id: "env.actor.approver",
    capability: "env.actor",
    api: "REST GET /users/{login}",
    args: ["api", `users/${state.approver}`],
    expect: "success",
  });
  state.approverId = pickNumber(parseJsonOutput(approver.stdout), "id") ?? null;
  session.saveState();

  await probeProject(session);
  await probeIssues(session);
  if (await commitWorkflow(session)) {
    await createEnvironment(session);
    await createRuleset(session);
    await createPullRequests(session);
    await probeLinkage(session);
    await probeGatesBeforeApproval(session);
    const runIdGate = await dispatchGatedRun(session, "reviewerGate");
    if (runIdGate !== undefined) {
      await readPendingDeployments(
        session,
        "deploy.non-reviewer-denied.pending",
        "deploy.non-reviewer-denied",
        runIdGate,
        false,
      );
      await approveDeployment(
        session,
        "deploy.non-reviewer-denied.approve",
        "deploy.non-reviewer-denied",
        runIdGate,
        "denied",
      );
    }
  } else {
    session.skip("delivery.all", "checks.workflow", "-", "workflow file could not be committed");
  }
}

async function approvePhase(session: ProbeSession): Promise<void> {
  const { state } = session;
  const login = await preflight(session);
  if (state.author !== null && login.toLowerCase() === state.author.toLowerCase()) {
    throw new Error(`approve must run as a second actor, not the PR author ${state.author}`);
  }
  if (login.toLowerCase() !== state.approver.toLowerCase()) {
    throw new Error(`approve must run as the environment reviewer ${state.approver}, not ${login}`);
  }
  await approvePullRequests(session);
  const gate = state.runs.reviewerGate;
  if (gate !== undefined) {
    await readPendingDeployments(
      session,
      "deploy.reviewer-approves.pending",
      "deploy.reviewer-approves",
      gate.id,
      true,
    );
    await approveDeployment(
      session,
      "deploy.reviewer-approves.approve",
      "deploy.reviewer-approves",
      gate.id,
      "success",
    );
  }
  const selfRun = await dispatchGatedRun(session, "selfReview");
  if (selfRun !== undefined) {
    await readPendingDeployments(
      session,
      "deploy.self-review-denied.pending",
      "deploy.self-review-denied",
      selfRun,
      false,
    );
    await approveDeployment(
      session,
      "deploy.self-review-denied.approve",
      "deploy.self-review-denied",
      selfRun,
      "denied",
    );
  }
}

async function verifyPhase(session: ProbeSession): Promise<void> {
  const { state } = session;
  const login = await preflight(session);
  if (state.author === null || login.toLowerCase() !== state.author.toLowerCase()) {
    throw new Error(
      `verify must run as the PR author ${state.author ?? "(unknown)"}, not ${login}`,
    );
  }
  await verifyPullRequests(session);
  await verifyDeployments(session);
}

function pickBoolean(value: unknown, path: string): boolean | null {
  const found = pick(value, path);
  return typeof found === "boolean" ? found : null;
}

async function runPhase(args: ProbeArgs, phase: Phase, statePath: string): Promise<void> {
  let state: ProbeState;
  if (phase === "setup") {
    if (existsSync(statePath) && !args.force) {
      throw new Error(`${statePath} exists; run cleanup for that run first or pass --force`);
    }
    if (args.target === undefined || args.approver === undefined)
      throw new Error("setup target missing");
    state = newState(args.target, args.approver, runId());
  } else {
    state = loadState(statePath);
  }
  const evidence = loadOrCreateEvidence(args.evidencePath, state);
  const session = new ProbeSession({
    state,
    statePath,
    evidence,
    evidencePath: args.evidencePath,
    phase,
    waitSeconds: args.waitSeconds,
  });
  session.saveState();
  const before = evidence.steps.length;
  try {
    if (phase === "setup") await setupPhase(session);
    else if (phase === "approve") await approvePhase(session);
    else if (phase === "verify") await verifyPhase(session);
    else {
      await preflight(session);
      await cleanupSandbox(session, {
        deleteIssues: args.deleteIssues,
        deleteFields: args.deleteFields,
      });
    }
    session.finishPhase();
  } catch (error) {
    session.observe({
      id: `${phase}.aborted`,
      capability: "env.actor",
      api: "-",
      command: "-",
      result: "error",
      detail: errorMessage(error),
    });
    session.finishPhase(errorMessage(error));
    process.exitCode = 1;
  } finally {
    session.saveState();
  }
  const counts = new Map<StepResult, number>();
  for (const step of evidence.steps.slice(before))
    counts.set(step.result, (counts.get(step.result) ?? 0) + 1);
  console.log(
    `\n${phase} finished as ${session.actor}: ` +
      [...counts].map(([result, n]) => `${String(n)} ${result}`).join(", ") +
      `\nstate: ${statePath}\nevidence: ${args.evidencePath}`,
  );
}

function printMatrix(evidencePath: string): void {
  const evidence = readEvidence(evidencePath);
  console.log(
    `OMI-006 capability matrix — ${evidence.repo}, Project #${String(evidence.projectNumber)}, run ${evidence.runId}`,
  );
  for (const phase of evidence.phases) {
    console.log(
      `- ${phase.phase} as ${phase.actor} ${phase.startedAt} → ${phase.finishedAt ?? "?"}${phase.aborted === undefined ? "" : ` (aborted: ${phase.aborted})`}`,
    );
  }
  console.log(`\n${renderMatrixMarkdown(buildMatrixRows(evidence.steps))}`);
  const unknown = unknownCapabilities(evidence.steps);
  if (unknown.length > 0) console.log(`\nSteps with unknown capability ids: ${unknown.join(", ")}`);
}

async function main(): Promise<void> {
  let args: ProbeArgs;
  try {
    args = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
    return;
  }
  if (args.command === "matrix") {
    printMatrix(args.evidencePath);
    return;
  }
  if (args.statePath === undefined) throw new Error("--state is required");
  try {
    await runPhase(args, args.command, args.statePath);
  } catch (error) {
    console.error(`refused: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}

await main();
