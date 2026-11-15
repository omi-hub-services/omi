import { describe, expect, it } from "vitest";
import { regressionTestSchema } from "../../../../src/application/contracts/result.ts";
import { produceRegressionEvidence } from "../../../../src/application/services/produce-regression-evidence.ts";
import { validRegressionEvidence } from "../../../../src/application/services/validate-review-evidence.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const test = { file: "tests/unit/x.test.ts", name: "fixes the bug" };
const runner = (baseExit: number | null, headExit: number | null) => (where: "base" | "head") =>
  Promise.resolve(
    where === "base"
      ? { revision: base, exitCode: baseExit }
      : { revision: head, exitCode: headExit },
  );

describe("produceRegressionEvidence", () => {
  it("records red on the base and green on the head with one argv", async () => {
    const evidence = await produceRegressionEvidence(
      ["npm", "run", "test:unit", "--"],
      test,
      runner(1, 0),
    );
    expect(evidence.base.command).toEqual([
      "npm",
      "run",
      "test:unit",
      "--",
      "tests/unit/x.test.ts",
      "-t",
      "fixes the bug",
    ]);
    expect(validRegressionEvidence(evidence, base, head)).toBe(true);
  });

  it.each([
    ["a green base", 0, 0],
    ["a red head", 1, 1],
  ])("produces evidence the validator refuses for %s", async (_label, baseExit, headExit) => {
    const evidence = await produceRegressionEvidence(["t"], test, runner(baseExit, headExit));
    expect(validRegressionEvidence(evidence, base, head)).toBe(false);
  });

  it.each([
    [null, 0],
    [1, null],
  ])("throws when a run has no exit status (%s, %s)", async (baseExit, headExit) => {
    await expect(
      produceRegressionEvidence(["t"], test, runner(baseExit, headExit)),
    ).rejects.toThrow("REGRESSION_RUN_FAILED");
  });
});

describe("regressionTestSchema", () => {
  it.each([
    { file: "/etc/passwd", name: "n" },
    { file: "../x.test.ts", name: "n" },
    { file: "-u", name: "n" },
    { file: "tests/a.test.ts", name: "two\nlines" },
    { file: "tests/a.test.ts", name: "" },
  ])("refuses %j", (input) => {
    expect(regressionTestSchema.safeParse(input).success).toBe(false);
  });
});
