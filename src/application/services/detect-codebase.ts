import { z } from "zod";
import { assertCredentialFree } from "../contracts/credential-input.js";
import { codebaseDetectionSchema } from "../contracts/project-onboarding.js";
import type { CodebaseDetection } from "../contracts/project-onboarding.js";
import type { CodebaseReader } from "../ports/codebase-reader.js";

type Language = Exclude<CodebaseDetection["language"], "unknown">;
type Commands = CodebaseDetection["commands"];
interface Stack {
  readonly language: Language;
  readonly packageManager?: string;
  readonly commands: Commands;
  readonly evidence: readonly string[];
}

const packageJsonSchema = z.looseObject({
  scripts: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
});

/** A command taken from repository text must not carry credential material into config. */
function safe(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  try {
    assertCredentialFree(command);
    return command;
  } catch {
    return undefined;
  }
}

function without(commands: Commands): Commands {
  return {
    ...(commands.test === undefined ? {} : { test: commands.test }),
    ...(commands.build === undefined ? {} : { build: commands.build }),
    ...(commands.lint === undefined ? {} : { lint: commands.lint }),
  };
}

async function detectNode(reader: CodebaseReader, files: ReadonlySet<string>): Promise<Stack> {
  const lockfiles: readonly (readonly [string, string])[] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  const lock = lockfiles.find(([name]) => files.has(name));
  const manager = lock?.[1] ?? "npm";
  let parsed: z.infer<typeof packageJsonSchema> = {};
  try {
    parsed = packageJsonSchema.parse(JSON.parse((await reader.readText("package.json")) ?? ""));
  } catch {
    // Unreadable or invalid package.json still proves a JavaScript project, but no commands.
  }
  const scripts = parsed.scripts ?? {};
  const script = (name: string): string | undefined => {
    const value = scripts[name];
    if (typeof value !== "string" || /no test specified/i.test(value)) return undefined;
    return manager === "npm" && name === "test" ? "npm test" : `${manager} run ${name}`;
  };
  const typed =
    files.has("tsconfig.json") ||
    parsed.devDependencies?.["typescript"] !== undefined ||
    parsed.dependencies?.["typescript"] !== undefined;
  const test = safe(script("test"));
  const build = safe(script("build"));
  const lint = safe(script("lint"));
  return {
    language: typed ? "typescript" : "javascript",
    packageManager: manager,
    commands: {
      ...(test === undefined ? {} : { test }),
      ...(build === undefined ? {} : { build }),
      ...(lint === undefined ? {} : { lint }),
    },
    evidence: ["package.json", ...(lock === undefined ? [] : [lock[0]])].concat(
      files.has("tsconfig.json") ? ["tsconfig.json"] : [],
    ),
  };
}

async function detectPython(reader: CodebaseReader, files: ReadonlySet<string>): Promise<Stack> {
  const manager = files.has("poetry.lock")
    ? "poetry"
    : files.has("uv.lock")
      ? "uv"
      : files.has("Pipfile")
        ? "pipenv"
        : "pip";
  const evidence = ["pyproject.toml", "requirements.txt", "setup.py", "poetry.lock", "uv.lock"];
  const markers = evidence.filter((name) => files.has(name));
  const texts = await Promise.all(
    markers
      .filter((name) => name === "pyproject.toml" || name === "requirements.txt")
      .map((name) => reader.readText(name)),
  );
  const usesPytest = texts.some((text) => text !== undefined && /\bpytest\b/i.test(text));
  const prefix = manager === "poetry" ? "poetry run " : manager === "uv" ? "uv run " : "";
  return {
    language: "python",
    packageManager: manager,
    commands: usesPytest ? { test: `${prefix}pytest` } : {},
    evidence: markers,
  };
}

/**
 * Reads only root marker files and never runs a command. Detection is evidence-based: a missing
 * marker means "unknown", never a default. Several stacks may coexist; the first by marker
 * priority is primary and the rest are reported as other languages.
 */
export async function detectCodebase(reader: CodebaseReader): Promise<CodebaseDetection> {
  const files = new Set(await reader.rootFiles());
  const has = (pattern: RegExp): string[] => [...files].filter((name) => pattern.test(name));
  const stacks: Stack[] = [];

  if (files.has("package.json")) stacks.push(await detectNode(reader, files));
  if (files.has("go.mod")) {
    stacks.push({
      language: "go",
      packageManager: "go",
      commands: { test: "go test ./...", build: "go build ./..." },
      evidence: ["go.mod"],
    });
  }
  if (files.has("Cargo.toml")) {
    stacks.push({
      language: "rust",
      packageManager: "cargo",
      commands: { test: "cargo test", build: "cargo build" },
      evidence: ["Cargo.toml"],
    });
  }
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((n) => files.has(n))) {
    stacks.push(await detectPython(reader, files));
  }
  if (files.has("pom.xml")) {
    stacks.push({
      language: "java",
      packageManager: "maven",
      commands: { test: "mvn test", build: "mvn package" },
      evidence: ["pom.xml"],
    });
  } else {
    const gradle = has(/^build\.gradle(\.kts)?$/);
    if (gradle.length > 0) {
      stacks.push({
        language: "java",
        packageManager: "gradle",
        commands: files.has("gradlew")
          ? { test: "./gradlew test", build: "./gradlew build" }
          : { test: "gradle test", build: "gradle build" },
        evidence: gradle,
      });
    }
  }
  const dotnet = has(/\.(sln|csproj|fsproj)$/);
  if (dotnet.length > 0) {
    stacks.push({
      language: "dotnet",
      packageManager: "dotnet",
      commands: { test: "dotnet test", build: "dotnet build" },
      evidence: dotnet,
    });
  }

  const [primary, ...rest] = stacks;
  return codebaseDetectionSchema.parse({
    language: primary?.language ?? "unknown",
    other_languages: rest.map((stack) => stack.language),
    ...(primary?.packageManager === undefined ? {} : { package_manager: primary.packageManager }),
    commands: primary === undefined ? {} : without(primary.commands),
    evidence: [...new Set(stacks.flatMap((stack) => stack.evidence))].sort(),
  });
}
