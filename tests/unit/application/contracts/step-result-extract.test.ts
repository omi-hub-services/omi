import { describe, expect, it } from "vitest";
import { extractStepResult } from "../../../../src/application/contracts/step-result-extract.ts";

const doc = { schemaVersion: 1, runId: "r", status: "succeeded", summary: "a { brace } in text" };
const json = JSON.stringify(doc);

describe("extractStepResult", () => {
  it("accepts a message that is entirely the JSON document", () => {
    expect(extractStepResult(`\n${json}\n`)).toEqual({ ok: true, value: doc });
  });

  it("accepts prose followed by exactly one fenced json block", () => {
    const message = `Done. Report below.\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`;
    expect(extractStepResult(message)).toEqual({ ok: true, value: doc });
  });

  it("accepts the same document fenced twice", () => {
    const fence = `\`\`\`json\n${json}\n\`\`\``;
    expect(extractStepResult(`${fence}\ntext\n${fence}`)).toEqual({ ok: true, value: doc });
  });

  it("refuses two different fenced json documents", () => {
    const other = JSON.stringify({ ...doc, status: "failed" });
    const message = `\`\`\`json\n${json}\n\`\`\`\nor\n\`\`\`json\n${other}\n\`\`\``;
    expect(extractStepResult(message)).toEqual({ ok: false, reason: "AMBIGUOUS" });
  });

  it("refuses a fenced document next to a different bare object, accepts an identical one", () => {
    const fence = `\`\`\`json\n${json}\n\`\`\``;
    expect(
      extractStepResult(`${fence}\nalso ${JSON.stringify({ ...doc, status: "failed" })}`),
    ).toEqual({
      ok: false,
      reason: "AMBIGUOUS",
    });
    expect(extractStepResult(`${fence}\nsame again: ${json}`)).toEqual({ ok: true, value: doc });
  });

  it("stays fast and reports no document on 100k unbalanced braces", () => {
    const started = Date.now();
    expect(extractStepResult(`prose ${"{".repeat(100_000)}`)).toEqual({
      ok: false,
      reason: "MISSING",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("falls back to the last JSON object in prose without a fence", () => {
    expect(extractStepResult(`first {"a":1} then the result:\n${json}\nthanks`)).toEqual({
      ok: true,
      value: doc,
    });
  });

  it("does not split an object at braces inside its strings", () => {
    expect(extractStepResult(`Result: ${json}`)).toEqual({ ok: true, value: doc });
  });

  it.each(["", "All checks passed", "```json\n{not json}\n```", "{ unbalanced"])(
    "reports no document for %j",
    (message) => {
      expect(extractStepResult(message)).toEqual({ ok: false, reason: "MISSING" });
    },
  );
});
