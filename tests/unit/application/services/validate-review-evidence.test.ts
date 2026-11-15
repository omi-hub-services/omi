import { expect, it } from "vitest";
import * as evidence from "../../../../src/application/services/validate-review-evidence.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const regression = {
  base: { revision: base, command: ["npm", "test", "regression"], exitCode: 1 },
  head: { revision: head, command: ["npm", "test", "regression"], exitCode: 0 },
};

it("requires the same regression command red on the exact base and green on the exact head", () => {
  expect(evidence.validRegressionEvidence(regression, base, head)).toBe(true);
  for (const invalid of [
    undefined,
    { ...regression, base: { ...regression.base, exitCode: 0 } },
    { ...regression, base: { ...regression.base, exitCode: null } },
    { ...regression, base: { ...regression.base, revision: head } },
    { ...regression, head: { ...regression.head, revision: base } },
    { ...regression, head: { ...regression.head, exitCode: 1 } },
    { ...regression, head: { ...regression.head, command: ["true"] } },
  ])
    expect(evidence.validRegressionEvidence(invalid, base, head)).toBe(false);
});
