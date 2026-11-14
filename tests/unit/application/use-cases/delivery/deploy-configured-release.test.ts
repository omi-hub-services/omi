import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  DeployConfig,
  DeployTarget,
} from "../../../../../src/application/contracts/project-config.ts";
import { deployConfiguredRelease } from "../../../../../src/application/use-cases/delivery/deploy-configured-release.ts";
import { approvalSubjectHash } from "../../../../../src/domain/approvals/approval.ts";
import type { ApprovalRequest } from "../../../../../src/domain/approvals/approval.ts";
import { createGithubDeployReader } from "../../../../../src/infrastructure/github/github-deploy.ts";
import { createGithubRemote } from "../../../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../../../src/infrastructure/github/github-rest-client.ts";
import { FakeGithub } from "../../../../contract/github/fake-github.ts";
import { preparationHarness } from "./prepare-pr-fakes.ts";

const digest = `sha256:${"a".repeat(64)}`;
const target: DeployTarget = {
  id: "app-r1",
  target_environment: "staging",
  artifact_digest: digest,
};
const config: DeployConfig = {
  workflow: "deploy.yml",
  tag_ref: "deploy-r1",
  workflow_sha: "b".repeat(40),
  issue_number: 48,
  allowed_actors: ["po"],
  author_actor: "omi-bot",
  allowed_repositories: ["acme/app"],
  allowed_environments: ["staging"],
};

function approvalFor(
  id: string,
  artifactDigest: string,
  status: ApprovalRequest["status"] = "approved",
): ApprovalRequest {
  const subject = { kind: "deploy" as const, artifactDigest, environment: "staging" };
  return {
    id,
    subjectId: target.id,
    subjectHash: approvalSubjectHash(subject),
    subject,
    status,
    version: 1,
    requestedAt: 1,
    ...(status === "approved"
      ? {
          decision: {
            id,
            subject,
            decision: "approved" as const,
            actor: "po",
            source: "github-actor" as const,
            decidedAt: 1,
          },
        }
      : {}),
  };
}

function setup(
  options: {
    approvals?: ApprovalRequest[];
    deploy?: DeployConfig | undefined;
    targets?: DeployTarget[];
    repository?: string;
  } = {},
) {
  const h = preparationHarness();
  const fake = new FakeGithub();
  fake.tags.set("acme/app:deploy-r1", "b".repeat(40));
  fake.deployEnvironment = "staging";
  const client = createGithubRestClient({
    transport: fake,
    now: () => h.clock.ms,
    random: () => 0,
    sleep: () => Promise.resolve(),
    policy: { maxTries: 1 },
  });
  const approvals = options.approvals ?? [approvalFor("approval-1", digest)];
  const deps = {
    ...h.deps,
    session: { renew: () => true, record: () => undefined },
    hasher: { sha256: (text: string) => createHash("sha256").update(text).digest("hex") },
    approvals: {
      get: (id: string) => approvals.find((a) => a.id === id),
      list: () => approvals,
    },
    deployments: createGithubDeployReader(client),
    github: createGithubRemote(client),
    sleep: () => Promise.resolve(),
    maxPolls: 2,
    pollIntervalMs: 1,
    deploy: "deploy" in options ? options.deploy : config,
    targets: options.targets ?? [target],
    repository: options.repository ?? "acme/app",
  };
  const dispatches = () =>
    fake.requests.filter((r) => r.method === "POST" && r.path.includes("/dispatches")).length;
  return { fake, deps, dispatches };
}

describe("deployConfiguredRelease", () => {
  it("deploys a configured target with the pipeline from project config and the stored approval", async () => {
    const { deps, dispatches } = setup();
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "verified",
      evidence: { artifactDigest: digest },
    });
    expect(dispatches()).toBe(1);
  });

  it("does not require the word sandbox in the repository or environment", async () => {
    const { deps } = setup();
    expect(deps.repository).not.toMatch(/sandbox/i);
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "verified",
    });
  });

  it("rejects a caller-supplied approval id, repository or pipeline value", async () => {
    const { deps, dispatches } = setup();
    for (const extra of [{ approvalId: "x" }, { repository: "evil/app" }, { workflow: "x.yml" }])
      await expect(
        deployConfiguredRelease(deps, { target: target.id, ...extra }),
      ).rejects.toThrow();
    expect(dispatches()).toBe(0);
  });

  it("reconciles the same intent when the command is repeated after a lost response", async () => {
    const { fake, deps, dispatches } = setup();
    fake.inject({
      method: "POST",
      pathIncludes: "/dispatches",
      effect: { type: "apply_then_fail", failure: "timeout" },
    });
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "pending",
    });
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "verified",
    });
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "verified",
    });
    expect(dispatches()).toBe(1);
  });

  it.each([
    ["no approval exists", [], "NO_APPROVAL"],
    [
      "the approval is still pending",
      [approvalFor("a1", digest, "pending")],
      "APPROVAL_NOT_ACTIVE",
    ],
    [
      "the approval pins an older digest",
      [approvalFor("a1", `sha256:${"c".repeat(64)}`)],
      "STALE_REVISION",
    ],
  ])("refuses without dispatching when %s", async (_name, approvals, reason) => {
    const { deps, dispatches } = setup({ approvals });
    expect(await deployConfiguredRelease(deps, { target: target.id })).toEqual({
      status: "refused",
      reason,
    });
    expect(dispatches()).toBe(0);
  });

  it("uses the current approved decision when an older stale one also exists", async () => {
    const stale = { ...approvalFor("old", `sha256:${"c".repeat(64)}`), requestedAt: 5 };
    const { deps } = setup({ approvals: [stale, approvalFor("new", digest)] });
    expect(await deployConfiguredRelease(deps, { target: target.id })).toMatchObject({
      status: "verified",
    });
  });

  it.each([
    ["deploy is not configured", { deploy: undefined }, "DEPLOY_NOT_CONFIGURED"],
    ["the target is not configured", { targets: [] }, "DEPLOY_TARGET_NOT_FOUND"],
    [
      "the repository is not allowlisted",
      { repository: "acme/other" },
      "DEPLOY_REPOSITORY_NOT_ALLOWED",
    ],
    [
      "the environment is not allowlisted",
      { deploy: { ...config, allowed_environments: ["production"] } },
      "DEPLOY_ENVIRONMENT_NOT_ALLOWED",
    ],
  ])("refuses without dispatching when %s", async (_name, options, reason) => {
    const { deps, dispatches } = setup(options);
    expect(await deployConfiguredRelease(deps, { target: target.id })).toEqual({
      status: "refused",
      reason,
    });
    expect(dispatches()).toBe(0);
  });
});
