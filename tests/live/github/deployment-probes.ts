// OMI-006 — deployment gate probes: an environment with a required reviewer and
// prevent_self_review, a workflow_dispatch job that waits on it, who may approve it and how its
// state is read. Sandbox only.
import type { CapabilityId, Verdict } from "./probe-model.ts";
import {
  parseJsonOutput,
  pick,
  pickArray,
  pickNumber,
  pickString,
  type ProbeSession,
  type RunKey,
} from "./probe-session.ts";

export async function createEnvironment(session: ProbeSession): Promise<void> {
  const { state } = session;
  if (state.approverId === null) {
    session.skip("deploy.environment.create", "deploy.environment", "-", "approver id unknown");
    return;
  }
  const path = `repos/${session.repo}/environments/${state.environmentName}`;
  const created = await session.step({
    id: "deploy.environment.create",
    capability: "deploy.environment",
    api: "REST PUT /repos/{r}/environments/{env}",
    args: ["api", "-X", "PUT", path, "--input", "-"],
    body: {
      wait_timer: 0,
      prevent_self_review: true,
      reviewers: [{ type: "User", id: state.approverId }],
      deployment_branch_policy: null,
      can_admins_bypass: false,
    },
    expect: "success",
  });
  state.environmentId = pickNumber(parseJsonOutput(created.stdout), "id") ?? null;
  session.saveState();
  await session.step({
    id: "deploy.environment.readback",
    capability: "deploy.environment",
    api: "REST GET /repos/{r}/environments/{env}",
    args: ["api", path],
    expect: "success",
    verify: (stdout): Verdict => {
      const data = parseJsonOutput(stdout);
      const rule = pickArray(data, "protection_rules").find(
        (r) => pickString(r, "type") === "required_reviewers",
      );
      const reviewers = pickArray(rule, "reviewers").map((r) => pickString(r, "reviewer.login"));
      const ok =
        pick(rule, "prevent_self_review") === true &&
        reviewers.includes(state.approver) &&
        pick(data, "can_admins_bypass") === false;
      return ok
        ? { result: "supported", note: "" }
        : {
            result: "partial",
            note: `prevent_self_review ${String(pick(rule, "prevent_self_review"))}, reviewers ${reviewers.join(", ")}, can_admins_bypass ${String(pick(data, "can_admins_bypass"))}`,
          };
    },
    observe: (stdout) => {
      const data = parseJsonOutput(stdout);
      const rule = pickArray(data, "protection_rules").find(
        (r) => pickString(r, "type") === "required_reviewers",
      );
      const preventSelf = pick(rule, "prevent_self_review");
      const bypass = pick(data, "can_admins_bypass");
      return {
        preventSelfReview: typeof preventSelf === "boolean" ? preventSelf : null,
        canAdminsBypass: typeof bypass === "boolean" ? bypass : null,
      };
    },
  });
}

async function runStatus(
  session: ProbeSession,
  runId: number,
): Promise<{ status: string; conclusion: string | null } | undefined> {
  const out = await session.gh(["api", `repos/${session.repo}/actions/runs/${String(runId)}`]);
  if (out.code !== 0) return undefined;
  const data = parseJsonOutput(out.stdout);
  const status = pickString(data, "status");
  return status === undefined
    ? undefined
    : { status, conclusion: pickString(data, "conclusion") ?? null };
}

/** Dispatches the workflow, finds the new run and waits until its gated job is `waiting`. */
export async function dispatchGatedRun(
  session: ProbeSession,
  key: RunKey,
): Promise<number | undefined> {
  const { state } = session;
  const since = Date.now() - 15_000;
  const known = new Set(Object.values(state.runs).map((r) => r.id));
  const dispatched = await session.step({
    id: `deploy.dispatch.${key}`,
    capability: "deploy.job-waits",
    api: "gh workflow run --ref",
    args: [
      "workflow",
      "run",
      state.workflowFile,
      "--repo",
      session.repo,
      "--ref",
      state.defaultBranch ?? "main",
    ],
    expect: "success",
  });
  if (!dispatched.ok) return undefined;
  const runId = await session.poll(
    async () => {
      const out = await session.gh([
        "api",
        `repos/${session.repo}/actions/workflows/${state.workflowFile}/runs?event=workflow_dispatch&per_page=20`,
      ]);
      const match = pickArray(parseJsonOutput(out.stdout), "workflow_runs").find((run) => {
        const id = pickNumber(run, "id");
        const created = Date.parse(pickString(run, "created_at") ?? "");
        return (
          id !== undefined &&
          !known.has(id) &&
          created >= since &&
          pickString(run, "triggering_actor.login") === session.actor
        );
      });
      return pickNumber(match, "id");
    },
    5_000,
    120,
  );
  if (runId === undefined) {
    session.skip(
      `deploy.find-run.${key}`,
      "deploy.job-waits",
      "REST GET /repos/{r}/actions/workflows/{w}/runs",
      "dispatched run not found within 120 s",
    );
    return undefined;
  }
  state.runs[key] = { id: runId, triggeredBy: session.actor };
  session.saveState();
  const waiting = await session.poll(async () => {
    const run = await runStatus(session, runId);
    return run !== undefined && (run.status === "waiting" || run.status === "completed")
      ? run
      : undefined;
  }, 5_000);
  session.observe({
    id: `deploy.job-waits.${key}`,
    capability: "deploy.job-waits",
    api: "REST GET /repos/{r}/actions/runs/{id} (status)",
    command: `(polled run ${String(runId)})`,
    result:
      waiting?.status === "waiting" ? "supported" : waiting === undefined ? "error" : "unsupported",
    detail: waiting === undefined ? "run never reached waiting" : `status ${waiting.status}`,
    observed: { runId, status: waiting?.status ?? null, conclusion: waiting?.conclusion ?? null },
  });
  return runId;
}

/** Reads pending_deployments; `want` is the expected current_user_can_approve. */
export async function readPendingDeployments(
  session: ProbeSession,
  id: string,
  capability: CapabilityId,
  runId: number,
  want: boolean,
): Promise<void> {
  await session.step({
    id,
    capability,
    api: "REST GET /repos/{r}/actions/runs/{id}/pending_deployments",
    args: ["api", `repos/${session.repo}/actions/runs/${String(runId)}/pending_deployments`],
    expect: "success",
    verify: (stdout): Verdict => {
      const entry = pickArray(parseJsonOutput(stdout), "")[0];
      const can = pick(entry, "current_user_can_approve");
      if (typeof can !== "boolean")
        return { result: "partial", note: "no pending deployment listed" };
      return can === want
        ? { result: "supported", note: `current_user_can_approve=${String(can)}` }
        : {
            result: "unsupported",
            note: `current_user_can_approve=${String(can)}, expected ${String(want)}`,
          };
    },
    observe: (stdout) => {
      const entry = pickArray(parseJsonOutput(stdout), "")[0];
      const can = pick(entry, "current_user_can_approve");
      return {
        environment: pickString(entry, "environment.name") ?? null,
        currentUserCanApprove: typeof can === "boolean" ? can : null,
        reviewers: pickArray(entry, "reviewers")
          .map((r) => pickString(r, "reviewer.login") ?? "?")
          .join(","),
      };
    },
  });
}

/** Posts an approval for the pending deployment; `expect` says whether it should be refused. */
export async function approveDeployment(
  session: ProbeSession,
  id: string,
  capability: CapabilityId,
  runId: number,
  expect: "success" | "denied",
): Promise<void> {
  const { state } = session;
  if (state.environmentId === null) {
    session.skip(id, capability, "-", "environment id unknown");
    return;
  }
  await session.step({
    id,
    capability,
    api: "REST POST /repos/{r}/actions/runs/{id}/pending_deployments",
    args: [
      "api",
      "-X",
      "POST",
      `repos/${session.repo}/actions/runs/${String(runId)}/pending_deployments`,
      "--input",
      "-",
    ],
    body: { environment_ids: [state.environmentId], state: "approved", comment: "omi-006 probe" },
    expect,
    // An accepted call that approved nothing (empty list) is still a refusal.
    verify: (stdout): Verdict => {
      const approved = pickArray(parseJsonOutput(stdout), "").length;
      if (expect === "denied") {
        return approved === 0
          ? { result: "supported", note: "HTTP 200 with an empty list: nothing was approved" }
          : {
              result: "unsupported",
              note: `the approval was accepted (${String(approved)} deployment(s))`,
            };
      }
      return approved > 0
        ? { result: "supported", note: "" }
        : { result: "partial", note: "accepted but empty list" };
    },
  });
  // Approved: wait up to 60 s for the run to leave `waiting`. Refused: give GitHub 10 s, then read.
  if (expect === "denied") await new Promise((resolve) => setTimeout(resolve, 10_000));
  const after =
    expect === "success"
      ? ((await session.poll(
          async () => {
            const run = await runStatus(session, runId);
            return run !== undefined && run.status !== "waiting" ? run : undefined;
          },
          3_000,
          60,
        )) ?? (await runStatus(session, runId)))
      : await runStatus(session, runId);
  session.observe({
    id: `${id}.status-after`,
    capability,
    api: "REST GET /repos/{r}/actions/runs/{id} (status)",
    command: `(read run ${String(runId)} after the attempt)`,
    result:
      after === undefined
        ? "error"
        : expect === "denied"
          ? after.status === "waiting"
            ? "supported"
            : "unsupported"
          : after.status !== "waiting"
            ? "supported"
            : "partial",
    detail: `status ${after?.status ?? "?"}`,
    observed: { status: after?.status ?? null },
  });
}

/** Verify phase: final state of both runs and every read path for the gate. */
export async function verifyDeployments(session: ProbeSession): Promise<void> {
  const { state } = session;
  const gate = state.runs.reviewerGate;
  if (gate !== undefined) {
    const done = await session.poll(async () => {
      const run = await runStatus(session, gate.id);
      return run?.status === "completed" ? run : undefined;
    }, 10_000);
    await session.step({
      id: "deploy.reviewer-approves.run-view",
      capability: "deploy.reviewer-approves",
      api: "gh run view --json status,conclusion,jobs",
      args: [
        "run",
        "view",
        String(gate.id),
        "--repo",
        session.repo,
        "--json",
        "status,conclusion,jobs",
      ],
      expect: "success",
      verify: (stdout): Verdict => {
        const data = parseJsonOutput(stdout);
        const job = pickArray(data, "jobs").find((j) => pickString(j, "name") === "gated-deploy");
        return pickString(job, "conclusion") === "success"
          ? { result: "supported", note: "gated-deploy ran after the reviewer approved" }
          : {
              result: "partial",
              note: `run ${done?.status ?? "?"}/${done?.conclusion ?? "?"}, job ${pickString(job, "conclusion") ?? "?"}`,
            };
      },
    });
    await session.step({
      id: "deploy.state-read.approvals",
      capability: "deploy.state-read",
      api: "REST GET /repos/{r}/actions/runs/{id}/approvals",
      args: ["api", `repos/${session.repo}/actions/runs/${String(gate.id)}/approvals`],
      expect: "success",
      verify: (stdout): Verdict => {
        const approvers = pickArray(parseJsonOutput(stdout), "")
          .filter((a) => pickString(a, "state") === "approved")
          .map((a) => pickString(a, "user.login"));
        return approvers.includes(state.approver)
          ? { result: "supported", note: `approved by ${state.approver}` }
          : { result: "partial", note: `approvals by ${approvers.join(", ")}` };
      },
    });
    await session.step({
      id: "deploy.state-read.deployments",
      capability: "deploy.state-read",
      api: "REST GET /repos/{r}/deployments?environment={env} + /statuses",
      args: [
        "api",
        `repos/${session.repo}/deployments?environment=${state.environmentName}&per_page=10`,
      ],
      expect: "success",
      observe: (stdout) => {
        const latest = pickArray(parseJsonOutput(stdout), "")[0];
        return {
          deployments: pickArray(parseJsonOutput(stdout), "").length,
          latestId: pickNumber(latest, "id") ?? null,
          latestSha: pickString(latest, "sha") ?? null,
          creator: pickString(latest, "creator.login") ?? null,
        };
      },
    });
    const deployments = await session.gh([
      "api",
      `repos/${session.repo}/deployments?environment=${state.environmentName}&per_page=1`,
    ]);
    const latestId = pickNumber(pickArray(parseJsonOutput(deployments.stdout), "")[0], "id");
    if (latestId !== undefined) {
      await session.step({
        id: "deploy.state-read.deployment-statuses",
        capability: "deploy.state-read",
        api: "REST GET /repos/{r}/deployments/{id}/statuses",
        args: ["api", `repos/${session.repo}/deployments/${String(latestId)}/statuses`],
        expect: "success",
        observe: (stdout) => ({
          states: pickArray(parseJsonOutput(stdout), "")
            .map((s) => pickString(s, "state") ?? "?")
            .join(","),
        }),
      });
    }
  }
  const self = state.runs.selfReview;
  if (self !== undefined) {
    const run = await runStatus(session, self.id);
    session.observe({
      id: "deploy.self-review-denied.still-waiting",
      capability: "deploy.self-review-denied",
      api: "REST GET /repos/{r}/actions/runs/{id} (status)",
      command: `(read run ${String(self.id)} triggered by ${self.triggeredBy})`,
      result: run === undefined ? "error" : run.status === "waiting" ? "supported" : "unsupported",
      detail: `status ${run?.status ?? "?"} (the only reviewer triggered it)`,
      observed: { status: run?.status ?? null, triggeredBy: self.triggeredBy },
    });
    await readPendingDeployments(
      session,
      "deploy.non-reviewer-denied.pending-self-run",
      "deploy.non-reviewer-denied",
      self.id,
      false,
    );
  }
}
