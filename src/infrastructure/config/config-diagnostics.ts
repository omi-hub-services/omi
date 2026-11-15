import { parseDocument } from "yaml";
import { ZodError } from "zod";
import type { ConfigValidationError } from "../../application/contracts/workflow-validation.js";

/** Same strict YAML boundary for runtime loading and offline diagnostics. */
export function parseConfigYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, customTags: [], schema: "core" });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) throw new AggregateError(problems, "Invalid YAML");
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export function configDiagnostics(file: string, error: unknown): ConfigValidationError[] {
  if (error instanceof Error && error.cause !== undefined)
    return configDiagnostics(file, error.cause);
  if (error instanceof AggregateError)
    return error.errors.flatMap((problem: unknown) => configDiagnostics(file, problem));
  if (error instanceof ZodError)
    return error.issues.map((issue) => ({
      file,
      path: issue.path.join(".") || "$",
      message: issue.message,
    }));
  const linePos = error instanceof Error && "linePos" in error ? error.linePos : undefined;
  const position = Array.isArray(linePos)
    ? (linePos[0] as { line: number; col: number } | undefined)
    : undefined;
  return [
    {
      file,
      path:
        position === undefined
          ? "$"
          : `line ${String(position.line)}, column ${String(position.col)}`,
      message: error instanceof Error ? error.message : "Cannot load configuration",
    },
  ];
}
