// Generates schemas/*.json from the Zod contracts (tech-stack.md §5).
// Usage: node --import ./tools/register-ts-imports.ts tools/generate-schemas.ts [--check]
//   (no flag) write the files and remove stale generated ones
//   --check   write nothing; exit 1 if schemas/ differs from the contracts
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderJsonSchemaFiles } from "../src/application/contracts/json-schema-catalog.ts";

const GENERATED = /\.schema\.json$/;

export function findSchemaDrift(
  expected: readonly { fileName: string; content: string }[],
  actual: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const file of expected) {
    const current = actual.get(file.fileName);
    if (current === undefined) problems.push(`${file.fileName}: missing`);
    else if (current !== file.content) problems.push(`${file.fileName}: out of date`);
  }
  const wanted = new Set(expected.map((f) => f.fileName));
  for (const name of actual.keys()) {
    if (!wanted.has(name)) problems.push(`${name}: not produced by any contract`);
  }
  return problems;
}

export function readGeneratedSchemas(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (GENERATED.test(name)) files.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return files;
}

if (import.meta.main) {
  const dir = resolve(import.meta.dirname, "..", "schemas");
  const expected = renderJsonSchemaFiles();
  mkdirSync(dir, { recursive: true });
  if (process.argv.includes("--check")) {
    const problems = findSchemaDrift(expected, readGeneratedSchemas(dir));
    if (problems.length > 0) {
      console.error("schemas:check failed; run `npm run schemas:generate` and commit the result:");
      for (const p of problems) console.error(`  ${p}`);
      process.exitCode = 1;
    } else {
      console.log(`schemas:check ok (${String(expected.length)} files)`);
    }
  } else {
    for (const file of expected) writeFileSync(join(dir, file.fileName), file.content);
    const wanted = new Set(expected.map((f) => f.fileName));
    for (const name of readGeneratedSchemas(dir).keys()) {
      if (!wanted.has(name)) rmSync(join(dir, name));
    }
    console.log(`schemas:generate wrote ${String(expected.length)} files to schemas/`);
  }
}
