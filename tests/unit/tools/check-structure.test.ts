import { describe, expect, it } from "vitest";
import { findViolations } from "../../../tools/check-structure.ts";

describe("findViolations", () => {
  it("accepts the standard root files and module paths", () => {
    expect(
      findViolations([
        "package.json",
        "tsconfig.build.json",
        "src/domain/runs/retry-policy.ts",
        "src/bootstrap/container.ts",
        "src/application/ports/.gitkeep",
        "tests/unit/domain/retry-policy.test.ts",
      ]),
    ).toEqual([]);
  });

  it.each([
    [".env.local", "environment/secret file"],
    ["docs/run.log", "state, log or key material"],
    ["tests/fixtures/state.sqlite", "state, log or key material"],
    ["tools/credentials.json", "credential file"],
    ["templates/project/.omi-squad/local/state/x.json", "omi-squad local runtime state"],
  ])("refuses to commit %s", (file, reason) => {
    expect(findViolations([file]).join("\n")).toContain(reason);
  });

  it("only lets bootstrap hold the composition-root entrypoints", () => {
    expect(findViolations(["src/bootstrap/wiring.ts"])).toEqual([
      "src/bootstrap/wiring.ts: bootstrap holds only cli.ts, runtime.ts, container.ts",
    ]);
  });

  it("does not exempt fixtures from secret checks", () => {
    expect(findViolations(["tests/fixtures/x/.env"])).toHaveLength(1);
  });
});
