import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderJsonSchemaFiles } from "../../../../src/application/contracts/json-schema-catalog.ts";
import { findSchemaDrift, readGeneratedSchemas } from "../../../../tools/generate-schemas.ts";

const SCHEMAS_DIR = resolve(import.meta.dirname, "../../../../schemas");

describe("generated JSON Schema", () => {
  it("schemas/ matches the Zod contracts (run `npm run schemas:generate` on failure)", () => {
    expect(findSchemaDrift(renderJsonSchemaFiles(), readGeneratedSchemas(SCHEMAS_DIR))).toEqual([]);
  });

  it("detects a stale, missing and stray file", () => {
    const expected = renderJsonSchemaFiles();
    const [first, ...rest] = expected;
    expect(first).toBeDefined();
    const actual = new Map(rest.map((f) => [f.fileName, f.content]));
    actual.set("stale.v1.schema.json", "{}\n");
    const stale = rest[0];
    if (stale !== undefined) actual.set(stale.fileName, `${stale.content} `);

    const problems = findSchemaDrift(expected, actual);
    expect(problems).toContain(`${first?.fileName ?? ""}: missing`);
    expect(problems).toContain("stale.v1.schema.json: not produced by any contract");
    expect(problems).toContain(`${stale?.fileName ?? ""}: out of date`);
  });

  it("does not require fields that Zod defaults, and marks files as generated", () => {
    const workflow = JSON.parse(
      renderJsonSchemaFiles().find((f) => f.fileName === "workflow.v1.schema.json")?.content ??
        "null",
    ) as {
      $comment?: string;
      required?: string[];
      properties?: { steps?: { items?: { required?: string[] } } };
    };
    expect(workflow.required).not.toContain("gates");
    expect(workflow.required).toContain("steps");
    const stepRequired = workflow.properties?.steps?.items?.required ?? [];
    expect(stepRequired).not.toContain("skills");
    expect(stepRequired).not.toContain("rules");
    expect(stepRequired).toContain("capability_profile");
    for (const file of renderJsonSchemaFiles()) {
      expect(file.content).toContain("Do not edit");
    }
  });

  it("ignores CRLF line endings when reading a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "omi-schemas-"));
    try {
      const expected = renderJsonSchemaFiles();
      for (const file of expected) {
        writeFileSync(join(dir, file.fileName), file.content.replaceAll("\n", "\r\n"));
      }
      expect(findSchemaDrift(expected, readGeneratedSchemas(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic", () => {
    expect(renderJsonSchemaFiles()).toEqual(renderJsonSchemaFiles());
  });

  it("carries the schema version and rejects extras in the emitted schemas", () => {
    const files = new Map(renderJsonSchemaFiles().map((f) => [f.fileName, f.content]));
    const command = JSON.parse(files.get("command.v1.schema.json") ?? "null") as {
      oneOf?: { additionalProperties?: boolean; properties?: Record<string, { const?: number }> }[];
    };
    expect(command.oneOf?.length).toBeGreaterThan(0);
    for (const variant of command.oneOf ?? []) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.properties?.["schemaVersion"]?.const).toBe(1);
    }
  });

  it("reflects effort and model fields in the models schema", () => {
    const models = JSON.parse(
      renderJsonSchemaFiles().find((f) => f.fileName === "models-config.v1.schema.json")?.content ??
        "null",
    ) as unknown;
    const text = JSON.stringify(models);
    expect(text).toContain('"min_effort"');
    expect(text).toContain('"supported_efforts"');
    expect(text).toContain('"xhigh"');
    expect(text).toContain('"verified_models"');
  });
});
