import { describe, expect, it } from "vitest";
import {
  desiredEnvironment,
  desiredRulesets,
  effectiveRuleFailures,
  evaluateSandbox,
  parseSetupOptions,
  remainingItemIds,
  settleAfterApply,
  planSteps,
  projectRuleset,
  type Observed,
  type SetupOptions,
} from "../../../../tools/sandbox-setup/model.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const options: SetupOptions = {
  repository: "omi-hub-services/omi-sandbox",
  environment: "sandbox",
  reviewer: "ttin-omihub",
  tag: "sandbox-deploy-r1",
  image: "docker.io/library/nginx",
  digest: DIGEST,
  deployWorkflow: "name: deploy\n",
  checkWorkflow: "name: check\n",
};

const empty: Observed = {
  mainSha: "m".repeat(40),
  developSha: null,
  files: {},
  deployWorkflowCommitSha: null,
  tagSha: null,
  rulesets: [],
  environment: null,
  reviewerId: 4242,
  variables: {},
  pipelineIssue: null,
};

/** What GitHub would report once every desired object exists. */
function satisfied(): Observed {
  const env = desiredEnvironment(4242);
  return {
    mainSha: "m".repeat(40),
    developSha: "m".repeat(40),
    files: {
      ".github/workflows/sandbox-deploy.yml": options.deployWorkflow,
      ".github/workflows/sandbox-check.yml": options.checkWorkflow,
    },
    deployWorkflowCommitSha: "c".repeat(40),
    tagSha: "c".repeat(40),
    rulesets: desiredRulesets().map((r, i) => ({ ...r, id: 100 + i })),
    environment: {
      canAdminsBypass: env.can_admins_bypass,
      preventSelfReview: env.prevent_self_review,
      reviewers: [{ type: "User", login: "ttin-omihub" }],
    },
    reviewerId: 4242,
    variables: { OMI_SANDBOX_IMAGE: options.image, OMI_SANDBOX_IMAGE_DIGEST: DIGEST },
    pipelineIssue: { number: 7, open: true },
  };
}

const ids = (observed: Observed, opts = options) =>
  planSteps(evaluateSandbox(observed, opts)).map((s) => s.id);

describe("sandbox setup plan", () => {
  it("plans every object, with files before rulesets and the tag after its commit", () => {
    const order = ids(empty);
    expect(order).toEqual([
      "branch-develop",
      "file-deploy-workflow",
      "tag-deploy-workflow",
      "file-check-workflow",
      "variable-image",
      "variable-digest",
      "environment",
      "ruleset-main",
      "ruleset-develop",
      "ruleset-tags",
      "issue-pipeline",
    ]);
    const tag = planSteps(evaluateSandbox(empty, options)).find(
      (s) => s.id === "tag-deploy-workflow",
    );
    expect(tag?.body).toMatchObject({ sha: "@sha:file-deploy-workflow" });
  });

  it("plans nothing when everything already matches (idempotent re-run)", () => {
    expect(ids(satisfied())).toEqual([]);
  });

  it("repairs a ruleset that gained a bypass actor", () => {
    const observed = satisfied();
    const drifted = observed.rulesets.map((r) =>
      r.name === "omi-sandbox-main"
        ? { ...r, bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }] }
        : r,
    );
    const steps = planSteps(evaluateSandbox({ ...observed, rulesets: drifted }, options));
    expect(steps.map((s) => `${s.method} ${s.id}`)).toEqual(["PUT ruleset-main"]);
    expect(steps[0]?.body).toMatchObject({ bypass_actors: [] });
  });

  it("repairs an environment that lets admins bypass or self-review", () => {
    const observed = satisfied();
    const weak = {
      ...observed,
      environment: { canAdminsBypass: true, preventSelfReview: false, reviewers: [] },
    };
    expect(ids(weak)).toEqual(["environment"]);
    const step = planSteps(evaluateSandbox(weak, options))[0];
    expect(step?.body).toMatchObject({
      can_admins_bypass: false,
      prevent_self_review: true,
      reviewers: [{ type: "User", id: 4242 }],
    });
  });

  it("refuses to overwrite a reviewed workflow whose content differs", () => {
    const observed = satisfied();
    const changed = { ...observed.files, ".github/workflows/sandbox-deploy.yml": "name: other\n" };
    const items = evaluateSandbox({ ...observed, files: changed }, options);
    expect(items.find((i) => i.id === "file-deploy-workflow")?.blocker).toMatch(/differs/);
    expect(() => planSteps(items)).toThrow(/differs/);
  });

  it("refuses to move an existing tag to another commit", () => {
    const items = evaluateSandbox({ ...satisfied(), tagSha: "d".repeat(40) }, options);
    expect(items.find((i) => i.id === "tag-deploy-workflow")?.blocker).toMatch(/never moved/);
  });

  it("updates a variable that holds another digest", () => {
    const observed = satisfied();
    const wrong = {
      ...observed,
      variables: { ...observed.variables, OMI_SANDBOX_IMAGE_DIGEST: `sha256:${"b".repeat(64)}` },
    };
    const steps = planSteps(evaluateSandbox(wrong, options));
    expect(steps.map((s) => `${s.method} ${s.id}`)).toEqual(["PATCH variable-digest"]);
  });

  it("reports a closed pipeline Issue as not verified instead of silently reopening it", () => {
    const items = evaluateSandbox(
      { ...satisfied(), pipelineIssue: { number: 7, open: false } },
      options,
    );
    expect(items.find((i) => i.id === "issue-pipeline")?.ok).toBe(false);
  });

  it("never lets any ruleset carry bypass actors", () => {
    for (const ruleset of desiredRulesets()) expect(ruleset.bypass_actors).toEqual([]);
  });

  it("requires a native review on main and a named check on both branches", () => {
    const main = desiredRulesets().find((r) => r.name === "omi-sandbox-main");
    const pr = main?.rules.find((r) => r.type === "pull_request");
    expect(pr?.parameters).toMatchObject({ required_approving_review_count: 1 });
    for (const name of ["omi-sandbox-main", "omi-sandbox-develop"]) {
      const rules = desiredRulesets().find((r) => r.name === name)?.rules ?? [];
      expect(JSON.stringify(rules.find((r) => r.type === "required_status_checks"))).toContain(
        "sandbox-check",
      );
    }
  });
});

describe("sandbox setup options", () => {
  const base = ["--image", "docker.io/library/nginx", "--digest", DIGEST];
  it("accepts a sandbox repository with a pinned digest", () => {
    expect(parseSetupOptions(base, "x", "y")).toMatchObject({
      repository: "omi-hub-services/omi-sandbox",
      digest: DIGEST,
    });
  });
  it("refuses the production repository in any case", () => {
    expect(() => parseSetupOptions([...base, "--repo", "Omi-Hub-Services/OMI"], "x", "y")).toThrow(
      /sandbox/,
    );
  });
  it("refuses a mutable image reference instead of a sha256 digest", () => {
    expect(() => parseSetupOptions(["--image", "nginx", "--digest", "latest"], "x", "y")).toThrow(
      /digest/,
    );
  });
  it("refuses a tag the tag ruleset would not protect", () => {
    expect(() => parseSetupOptions([...base, "--tag", "v1"], "x", "y")).toThrow(/sandbox-deploy-/);
  });
  it("reduces a GitHub ruleset response to the fields the script sets", () => {
    const [main] = desiredRulesets();
    const raw = {
      id: 9,
      name: main?.name,
      target: "branch",
      enforcement: "active",
      source: "x",
      bypass_actors: [],
      conditions: main?.conditions,
      rules: main?.rules.map((r) => ({
        ...r,
        parameters: r.parameters && { ...r.parameters, allowed_merge_methods: ["merge"] },
      })),
    };
    const { id, ...projected } = projectRuleset(raw) ?? { id: 0 };
    expect(id).toBe(9);
    expect(projected).toEqual(main);
  });
  it("refuses an unknown flag", () => {
    expect(() => parseSetupOptions([...base, "--force"], "x", "y")).toThrow(/force/);
  });
});

describe("post-apply settling", () => {
  const lagging: Observed = { ...satisfied(), tagSha: null, deployWorkflowCommitSha: null };
  const lagItems = () => evaluateSandbox(lagging, options);

  it("names the remaining items and never throws on a lagging read", () => {
    expect(() => remainingItemIds(lagItems())).not.toThrow();
    expect(remainingItemIds(lagItems())).toEqual(["tag-deploy-workflow"]);
  });

  it("retries until the read catches up, sleeping between reads", async () => {
    const reads = [lagItems(), lagItems(), evaluateSandbox(satisfied(), options)];
    const sleeps: number[] = [];
    const remaining = await settleAfterApply({
      read: () => reads.shift() ?? [],
      attempts: 5,
      delayMs: 250,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(remaining).toEqual([]);
    expect(sleeps).toEqual([250, 250]);
  });

  it("reports what is still missing after the last attempt", async () => {
    let calls = 0;
    const remaining = await settleAfterApply({
      read: () => {
        calls++;
        return lagItems();
      },
      attempts: 3,
      delayMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(calls).toBe(3);
    expect(remaining).toEqual(["tag-deploy-workflow"]);
  });
});

describe("effective rules on main", () => {
  const effective = () =>
    desiredRulesets()
      .find((r) => r.name === "omi-sandbox-main")
      ?.rules.map((r) => ({ ...r, ruleset_id: 1 }));

  it("accepts the rules the ruleset sets", () => {
    expect(effectiveRuleFailures(effective())).toEqual([]);
  });

  it("rejects a pull_request rule that no longer requires an approval", () => {
    const weak = effective()?.map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...r.parameters, required_approving_review_count: 0 } }
        : r,
    );
    expect(effectiveRuleFailures(weak)).toEqual([expect.stringContaining("pull_request")]);
  });

  it("rejects a missing named check even when the text appears elsewhere", () => {
    const weak = effective()?.filter((r) => r.type !== "required_status_checks");
    expect(effectiveRuleFailures(weak)).toEqual([
      expect.stringContaining("required_status_checks"),
    ]);
  });

  it("rejects an unreadable answer", () => {
    expect(effectiveRuleFailures({ message: "Not Found" }).length).toBeGreaterThan(0);
  });
});
