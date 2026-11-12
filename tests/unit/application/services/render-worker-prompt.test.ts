import { expect, it } from "vitest";
import { renderWorkerPrompt } from "../../../../src/application/services/render-worker-prompt.js";

it("provides a pure single-pass renderer that refuses unresolved skeleton slots", () => {
  const slots = {
    identity: "identity",
    workspace: "workspace",
    read_first: "read first",
    task_context: "{{rules}}",
    notes: "notes",
    skills: "skills",
    rules: "rules",
    restrictions: "restrictions",
    report_contract: "report",
  };
  const skeleton = Object.keys(slots)
    .map((s) => `{{${s}}}`)
    .join("\n");
  expect(renderWorkerPrompt(`marker\n${skeleton}`, slots)).toBe(
    `marker\n${Object.values(slots).join("\n")}`,
  );
  expect(() => renderWorkerPrompt(`${skeleton} {{unknown}}`, slots)).toThrow(/slot/);
  expect(() => renderWorkerPrompt(skeleton.replace("{{rules}}", ""), slots)).toThrow(/slot/);
  expect(() => renderWorkerPrompt(`${skeleton} {{broken`, slots)).toThrow(/slot/);
});
