import { expect, it } from "vitest";
import { prepareRunPr } from "../../../../../src/application/use-cases/delivery/prepare-run-pr.ts";
import { request } from "./prepare-pr-fakes.ts";

import { runPreparation } from "./prepare-run-pr-fakes.ts";

const input = { runId: "r", title: request.title, evidence: request.evidence };

it("creates and reuses the run's PR and saves its mapping", async () => {
  const h = runPreparation();
  expect(await prepareRunPr(h.deps, input)).toMatchObject({
    ok: true,
    status: "verified",
    mapping: {
      projectId: request.projectId,
      taskId: request.taskId,
      repository: request.repository,
      issueNumber: request.issueNumber,
      prNumber: 100,
    },
  });
  expect(h.state.pull).toMatchObject({
    head: request.head,
    base: "develop",
    repository: request.repository,
  });
  expect(await prepareRunPr(h.deps, input)).toMatchObject({ ok: true, status: "verified" });
  expect(h.github.sends).toHaveLength(2);
});

it.each(["repository", "issueNumber", "projectId", "taskId", "head"])(
  "rejects caller-supplied %s",
  async (key) => {
    const h = runPreparation();
    expect(await prepareRunPr(h.deps, { ...input, [key]: "forged" })).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(h.state.pull).toBeUndefined();
  },
);

it("returns the delivery refusal without hiding its reason", async () => {
  const h = runPreparation();
  expect(await prepareRunPr(h.deps, { ...input, evidence: ["one"] })).toEqual({
    ok: false,
    reason: "AC_EVIDENCE_MISMATCH",
  });
});

it("refuses a workspace that moved off the recorded task branch", async () => {
  const h = runPreparation();
  const inspected = h.deps.workspaces.inspect(h.attempt.workspace.path);
  if (!inspected.ok) throw new Error("FIXTURE");
  expect(
    await prepareRunPr(
      {
        ...h.deps,
        workspaces: {
          inspect: () => ({ ok: true, value: { ...inspected.value, branch: "develop" } }),
        },
      },
      input,
    ),
  ).toEqual({ ok: false, reason: "WORKSPACE_MISMATCH" });
  expect(h.state.pull).toBeUndefined();
});

it("requires the run and all its steps to be complete before PR writes", async () => {
  const h = runPreparation();
  expect(
    await prepareRunPr({ ...h.deps, runs: { ...h.deps.runs, get: () => undefined } }, input),
  ).toEqual({ ok: false, reason: "RUN_NOT_FOUND" });
  expect(
    await prepareRunPr(
      {
        ...h.deps,
        runs: { ...h.deps.runs, get: () => ({ id: "r", status: "paused", version: 1 }) },
      },
      input,
    ),
  ).toEqual({ ok: false, reason: "RUN_NOT_DELIVERABLE" });
  expect(
    await prepareRunPr(
      {
        ...h.deps,
        runs: {
          ...h.deps.runs,
          listSteps: () => [
            { id: "s", runId: "r", stepId: "implement", status: "running", version: 1 },
          ],
        },
      },
      input,
    ),
  ).toEqual({ ok: false, reason: "STEPS_NOT_SUCCEEDED" });
  expect(h.state.pull).toBeUndefined();
});

it("refuses missing task or workspace records before PR writes", async () => {
  const h = runPreparation();
  expect(await prepareRunPr({ ...h.deps, plans: { forRun: () => undefined } }, input)).toEqual({
    ok: false,
    reason: "TASK_NOT_FOUND",
  });
  expect(
    await prepareRunPr({ ...h.deps, attempts: { latestForStep: () => undefined } }, input),
  ).toEqual({ ok: false, reason: "WORKSPACE_UNAVAILABLE" });
  expect(
    await prepareRunPr(
      { ...h.deps, attempts: { latestForStep: () => ({ ...h.attempt, runId: "other" }) } },
      input,
    ),
  ).toEqual({ ok: false, reason: "WORKSPACE_MISMATCH" });
  expect(h.state.pull).toBeUndefined();
});

it("preserves pending delivery and propagates unexpected errors", async () => {
  const h = runPreparation();
  h.github.sendScript.push({ kind: "outcome_unknown", code: "TIMEOUT" });
  expect(await prepareRunPr(h.deps, input)).toMatchObject({ ok: true, status: "pending" });
  const error = new Error("unexpected reader failure");
  await expect(
    prepareRunPr(
      {
        ...h.deps,
        prepare: {
          ...h.deps.prepare,
          reader: { ...h.deps.prepare.reader, issueBody: () => Promise.reject(error) },
        },
      },
      input,
    ),
  ).rejects.toBe(error);
});
