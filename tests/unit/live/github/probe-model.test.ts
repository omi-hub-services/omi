import { describe, expect, it } from "vitest";
import {
  aggregateResult,
  assertSandboxCall,
  buildMatrixRows,
  CAPABILITIES,
  type CallOutcome,
  classifyOutcome,
  formatCall,
  httpStatusOf,
  parseProbeArgs,
  parseTokenScopes,
  redact,
  renderMatrixMarkdown,
  type StepRecord,
  unknownCapabilities,
} from "../../../live/github/probe-model.ts";

const sandbox = {
  repo: "omi-hub-services/omi-sandbox",
  projectOwner: "omi-hub-services",
  projectNumber: 2,
};
const outcome = (code: number, stderr = "", stdout = ""): CallOutcome => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});
const common = ["--state", "s.json", "--evidence", "e.json"];

describe("production guard", () => {
  it("refuses the production repository in any spelling", () => {
    for (const repo of ["omi-hub-services/omi", "OMI-HUB-SERVICES/OMI"]) {
      expect(() =>
        parseProbeArgs([
          "setup",
          "--repo",
          repo,
          "--project",
          "2",
          "--approver",
          "ttin-omihub",
          ...common,
        ]),
      ).toThrow(/production repository/);
    }
  });

  it("refuses Project #1", () => {
    expect(() =>
      parseProbeArgs([
        "setup",
        "--repo",
        sandbox.repo,
        "--project",
        "1",
        "--approver",
        "x",
        ...common,
      ]),
    ).toThrow(/Project #1/);
  });

  it("accepts the sandbox and derives the Project owner from the repo", () => {
    const args = parseProbeArgs([
      "setup",
      "--repo",
      sandbox.repo,
      "--project",
      "2",
      "--approver",
      "ttin-omihub",
      ...common,
    ]);
    expect(args.target).toEqual(sandbox);
    expect(args.waitSeconds).toBe(600);
  });

  it("rejects a non-numeric Project and a malformed repo", () => {
    expect(() =>
      parseProbeArgs([
        "setup",
        "--repo",
        sandbox.repo,
        "--project",
        "two",
        "--approver",
        "x",
        ...common,
      ]),
    ).toThrow();
    expect(() =>
      parseProbeArgs([
        "setup",
        "--repo",
        "no-slash",
        "--project",
        "2",
        "--approver",
        "x",
        ...common,
      ]),
    ).toThrow(/OWNER\/NAME/);
  });

  it("later phases take the target only from the state file", () => {
    expect(() => parseProbeArgs(["approve", "--repo", sandbox.repo, ...common])).toThrow(
      /from --state/,
    );
    expect(parseProbeArgs(["approve", ...common]).target).toBeUndefined();
    expect(() => parseProbeArgs(["verify", "--evidence", "e.json"])).toThrow(/--state is required/);
    expect(parseProbeArgs(["matrix", "--evidence", "e.json"]).command).toBe("matrix");
  });

  const call = (args: string[], input?: string) => () => {
    assertSandboxCall(args, input, sandbox);
  };

  it("blocks any gh call that names the production repo, but not the sandbox", () => {
    expect(call(["api", "repos/omi-hub-services/omi/issues"])).toThrow();
    expect(call(["pr", "view", "1", "--repo", "omi-hub-services/omi"])).toThrow();
    expect(call(["api", "graphql"], '{"q":"omi-hub-services/omi#3"}')).toThrow(/request body/);
    expect(call(["api", "repos/omi-hub-services/omi-sandbox/issues"])).not.toThrow();
  });

  it("blocks gh project calls on another Project number", () => {
    expect(call(["project", "item-add", "1", "--owner", "o"])).toThrow(/Project #1/);
    expect(call(["project", "item-add", "2", "--owner", "o"])).not.toThrow();
    expect(call(["project", "item-edit", "--id", "X"])).not.toThrow();
  });
});

describe("classifyOutcome", () => {
  it("success: exit 0 is supported unless the verifier says otherwise", () => {
    expect(classifyOutcome("success", outcome(0)).result).toBe("supported");
    expect(
      classifyOutcome("success", outcome(0), () => ({ result: "partial", note: "x" })).result,
    ).toBe("partial");
  });

  it("success: a GraphQL errors array fails the call even with exit 0", () => {
    const v = classifyOutcome(
      "success",
      outcome(
        0,
        "",
        '{"errors":[{"message":"Field \'blockedBy\' doesn\'t exist on type \'Issue\'"}]}',
      ),
    );
    expect(v.result).toBe("unsupported");
    expect(v.note).toMatch(/blockedBy/);
  });

  it("success: 404 is unsupported, 422 is an error, 5xx is a transient error", () => {
    expect(classifyOutcome("success", outcome(1, "gh: Not Found (HTTP 404)")).result).toBe(
      "unsupported",
    );
    expect(classifyOutcome("success", outcome(1, "gh: Validation Failed (HTTP 422)")).result).toBe(
      "error",
    );
    expect(classifyOutcome("success", outcome(1, "gh: Server Error (HTTP 502)")).note).toMatch(
      /transient/,
    );
  });

  it("denied: a 4xx refusal means the gate held; acceptance means it did not", () => {
    expect(
      classifyOutcome("denied", outcome(1, "gh: Can not approve your own pull request (HTTP 422)"))
        .result,
    ).toBe("supported");
    expect(classifyOutcome("denied", outcome(0)).result).toBe("unsupported");
  });

  it("denied: a 200 that acted on nothing can still count as refused via the verifier", () => {
    const v = classifyOutcome("denied", outcome(0, "", "[]"), (s) =>
      s === "[]" ? { result: "supported", note: "empty" } : { result: "unsupported", note: "" },
    );
    expect(v.result).toBe("supported");
  });

  it("denied: a malformed call, a timeout or a missing gh is never a refusal", () => {
    expect(classifyOutcome("denied", outcome(1, "unknown flag: --aprove")).result).toBe("error");
    expect(classifyOutcome("denied", { ...outcome(124, "killed"), timedOut: true }).result).toBe(
      "error",
    );
    expect(classifyOutcome("denied", outcome(127, "spawn gh ENOENT")).result).toBe("error");
  });

  it("reads the last HTTP status from gh stderr", () => {
    expect(httpStatusOf("gh: Not Found (HTTP 404)")).toBe(404);
    expect(httpStatusOf("no status")).toBeNull();
  });
});

describe("evidence hygiene", () => {
  it("redacts tokens and e-mails but keeps commit SHAs and node IDs", () => {
    const sha = "0a7e1e9c552b5a743ce0a7e1e9c552b5a743ce01";
    const text = redact(
      `token gho_${"a".repeat(36)} pat github_pat_${"B1_".repeat(10)} Authorization: Bearer abc.def-ghi mail dev@example.com sha ${sha} node PVT_kwDOFSS4LM4Bq-O_`,
    );
    expect(text).not.toMatch(/gho_a|github_pat_B|abc\.def|dev@example\.com/);
    expect(text).toContain(sha);
    expect(text).toContain("PVT_kwDOFSS4LM4Bq-O_");
  });

  it("formats the call with its stdin body, redacted", () => {
    const line = formatCall(
      ["api", "-X", "POST", "repos/o/r/issues", "--input", "-"],
      '{"title":"a b","x":"ghp_' + "z".repeat(36) + '"}',
    );
    expect(line.startsWith("gh api -X POST repos/o/r/issues --input - <<< ")).toBe(true);
    expect(line).toContain("[REDACTED_TOKEN]");
  });

  it("keeps only the scope list from gh auth status", () => {
    const status =
      "github.com\n  ✓ Logged in to github.com account a (keyring)\n  - Active account: true\n  - Token: gho_************\n  - Token scopes: 'gist', 'project', 'repo', 'workflow'\n";
    expect(parseTokenScopes(status)).toEqual(["gist", "project", "repo", "workflow"]);
    expect(parseTokenScopes("no scopes here")).toBeNull();
  });
});

describe("capability matrix", () => {
  const step = (capability: string, result: StepRecord["result"], id = capability): StepRecord => ({
    id,
    capability,
    phase: "setup",
    actor: "minibox-claude-code",
    api: "REST GET /x",
    command: "gh api x",
    expect: "success",
    result,
    httpStatus: result === "unsupported" ? 404 : null,
    exitCode: 0,
    detail: "",
    observed: {},
    at: "2026-11-10T00:00:00Z",
    durationMs: 1,
  });

  it("aggregates step results into one row result", () => {
    expect(aggregateResult([])).toBe("pending live run");
    expect(aggregateResult(["supported", "supported"])).toBe("supported");
    expect(aggregateResult(["unsupported"])).toBe("unsupported");
    expect(aggregateResult(["supported", "unsupported"])).toBe("partial");
    expect(aggregateResult(["error", "supported"])).toBe("partial");
  });

  it("builds one row per capability, pending when no step ran", () => {
    const rows = buildMatrixRows([
      step("issue.create", "supported"),
      step("issue.dependency.add", "unsupported", "dep.rest"),
    ]);
    expect(rows).toHaveLength(CAPABILITIES.length);
    expect(rows.find((r) => r.capability.id === "issue.create")?.result).toBe("supported");
    expect(rows.find((r) => r.capability.id === "issue.dependency.add")?.evidence).toEqual([
      "dep.rest: unsupported HTTP 404",
    ]);
    expect(rows.find((r) => r.capability.id === "pr.merge")?.result).toBe("pending live run");
    const table = renderMatrixMarkdown(rows);
    expect(table.split("\n")).toHaveLength(CAPABILITIES.length + 2);
  });

  // Ids used by probe steps are checked at compile time (CapabilityId); duplicates are not.
  it("has unique capability ids", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports steps whose capability is not a matrix row (e.g. an old evidence file)", () => {
    const stray = { ...step("issue.create", "supported"), capability: "issue.renamed" };
    expect(unknownCapabilities([step("issue.create", "supported"), stray])).toEqual([
      "issue.renamed",
    ]);
  });
});
