import { existsSync } from "node:fs";
import { expect, it } from "vitest";

it("validates immutable pin records and rejects malformed or repeated rollback SHAs", async () => {
  expect(existsSync("tools/coordinator/pin-policy.ts")).toBe(true);
  const { parsePinRecord } = await import("../../../../tools/coordinator/pin-policy.ts");
  const record = { schemaVersion: 1, sha: "a".repeat(40), source: "develop", previous: null };
  expect(parsePinRecord(record)).toEqual(record);
  for (const over of [
    { sha: "main" },
    { sha: "a".repeat(7) },
    { source: "task/x" },
    { previous: { sha: record.sha, source: "main" } },
    { extra: true },
  ]) {
    expect(() => parsePinRecord({ ...record, ...over })).toThrow();
  }
});

it("requires trusted provenance and the latest completed green CI check", async () => {
  expect(existsSync("tools/coordinator/pin-policy.ts")).toBe(true);
  const { refreshRefusal, refreshedRecord } =
    await import("../../../../tools/coordinator/pin-policy.ts");
  const record = {
    schemaVersion: 1 as const,
    sha: "a".repeat(40),
    source: "develop" as const,
    previous: null,
  };
  const green = {
    provenance: true,
    checks: [{ name: "check", status: "completed", conclusion: "success", id: 1 }],
  };
  expect(refreshRefusal(green)).toBeUndefined();
  for (const checks of [
    [],
    [{ ...green.checks[0], status: "in_progress" }],
    [{ ...green.checks[0], conclusion: "failure" }],
    [{ ...green.checks[0], name: "other" }],
    [...green.checks, { ...green.checks[0], id: 2, conclusion: "cancelled" }],
  ]) {
    expect(refreshRefusal({ provenance: true, checks })).toBeDefined();
  }
  expect(refreshRefusal({ ...green, provenance: false })).toBeDefined();
  expect(refreshedRecord(record, "b".repeat(40), "main").previous).toEqual({
    sha: record.sha,
    source: record.source,
  });
});

it("runs Windows npm through Node rather than trying to spawn a cmd script without a shell", async () => {
  const policy = await import("../../../../tools/coordinator/pin-policy.ts");
  expect(policy).toHaveProperty("pinInstallCommand");
  if ("pinInstallCommand" in policy && typeof policy.pinInstallCommand === "function") {
    expect(
      policy.pinInstallCommand("win32", "C:\\Program Files\\nodejs\\node.exe", "C:\\pin"),
    ).toMatchObject({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "ci",
        "--ignore-scripts",
      ],
    });
  }
});

it("protects the configured WSL work checkout even when its default is used", async () => {
  const policy = await import("../../../../tools/coordinator/pin-policy.ts");
  const { wslTarget } = await import("../../../../tools/coordinator/coordinator-settings.ts");
  expect(policy).toHaveProperty("pinWorkRoot");
  if ("pinWorkRoot" in policy && typeof policy.pinWorkRoot === "function") {
    expect(policy.pinWorkRoot("linux", {})).toBe(wslTarget("linux", {}).repoDir);
    expect(
      policy.pinWorkRoot("win32", { OMI_WSL_DISTRO: "Ubuntu", OMI_WSL_REPO_DIR: "/home/u/work" }),
    ).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\work");
  }
});
