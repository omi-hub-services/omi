// File-placement guard from docs/architecture/architecture.md §3 and §14.
// Usage: node tools/check-structure.ts [dir]   (dir defaults to the cwd)
// Checks every tracked or untracked-but-not-ignored file, so the result matches
// what can be committed. Changing an allowlist here requires updating
// architecture.md §3 and an ADR first.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  "vitest.config.ts",
  ".dependency-cruiser.cjs",
  ".nvmrc",
  ".gitignore",
  ".npmrc",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "CHANGELOG.md",
]);
const ROOT_FILE_PATTERNS = [/^tsconfig(\.[a-z0-9-]+)?\.json$/];
const ROOT_DIRS = new Set([
  "src",
  "templates",
  "migrations",
  "schemas",
  "tests",
  "tools",
  "docs",
  ".github",
  ".claude",
]);

// Directories allowed under src/ (architecture.md §3.1–3.3). Files may sit directly in these.
const SRC_DIRS = new Set([
  ...["tasks", "workflows", "runs", "agents", "profiles", "approvals", "delivery", "shared"].map(
    (d) => `src/domain/${d}`,
  ),
  ...["project", "tasks", "runs", "profiles", "approvals", "delivery", "sync"].map(
    (d) => `src/application/use-cases/${d}`,
  ),
  "src/application/ports",
  "src/application/contracts",
  "src/application/services",
  "src/infrastructure/persistence/sqlite",
  "src/infrastructure/executors/claude-code",
  "src/infrastructure/executors/codex",
  ...["processes", "profiles", "git", "github", "artifacts", "config", "observability"].map(
    (d) => `src/infrastructure/${d}`,
  ),
  "src/interfaces/cli/commands",
  "src/interfaces/cli/presenters",
  "src/interfaces/ipc",
  "src/bootstrap",
]);
const BOOTSTRAP_FILES = new Set(["cli.ts", "runtime.ts", "container.ts"]);
const TEST_DIRS = ["unit", "integration", "contract", "e2e", "live"].map((d) => `tests/${d}/`);

const KEBAB_TS = /^[a-z0-9]+(-[a-z0-9]+)*((\.contract)?\.(test|spec))?\.ts$/;
const VAGUE_TOKENS = new Set([
  "utils",
  "util",
  "helpers",
  "helper",
  "common",
  "misc",
  "final",
  "new",
  "v2",
]);
const VAGUE_FRAGMENTS = ["utils", "helpers", "misc", "final", "new", "v2"];
const FORBIDDEN_FILES: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)\.env(\..*)?$/, reason: "environment/secret file" },
  {
    pattern: /\.(sqlite|sqlite-wal|sqlite-shm|db|db-wal|db-shm|log|pem|key)$/,
    reason: "state, log or key material",
  },
  { pattern: /(^|\/)(credentials?|auth)\.json$/, reason: "credential file" },
  { pattern: /(^|\/)\.omi-squad\/local\//, reason: "omi-squad local runtime state" },
];

export function findViolations(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const parts = file.split("/");
    const top = parts[0] ?? "";
    const name = parts.at(-1) ?? "";

    for (const { pattern, reason } of FORBIDDEN_FILES) {
      if (pattern.test(file)) out.push(`${file}: must not be committed (${reason})`);
    }

    if (parts.length === 1) {
      if (!ROOT_FILES.has(name) && !ROOT_FILE_PATTERNS.some((p) => p.test(name))) {
        out.push(`${file}: root file not in the allowlist (architecture.md §3)`);
      }
      continue;
    }
    if (!ROOT_DIRS.has(top)) {
      out.push(`${file}: root directory "${top}/" not in the allowlist (architecture.md §3)`);
      continue;
    }

    if (/\.(test|spec)\.ts$/.test(name) && !TEST_DIRS.some((d) => file.startsWith(d))) {
      out.push(`${file}: test files belong under ${TEST_DIRS.join(", ")}`);
    }

    for (const directory of parts.slice(0, -1)) {
      if (
        directory.split("-").some((token) => VAGUE_TOKENS.has(token)) ||
        VAGUE_FRAGMENTS.some((fragment) => directory.includes(fragment))
      ) {
        out.push(`${file}: vague directory; name the responsibility (architecture.md §14.6)`);
      }
    }
    if (name.endsWith(".ts")) {
      if (!KEBAB_TS.test(name)) {
        out.push(`${file}: TypeScript files must be kebab-case .ts`);
      }
      const stem = name.replace(/(\.contract)?\.(test|spec)\.ts$|\.ts$/, "");
      if (
        stem === "manager" ||
        stem.split("-").some((token) => VAGUE_TOKENS.has(token)) ||
        VAGUE_FRAGMENTS.some((fragment) => stem.includes(fragment))
      ) {
        out.push(`${file}: vague name; name the responsibility (architecture.md §14.6)`);
      }
    }

    if (top === "src") {
      if (name !== ".gitkeep" && !name.endsWith(".ts")) {
        out.push(`${file}: source files must be kebab-case .ts`);
      }
      const dir = parts.slice(0, -1).join("/");
      if (!SRC_DIRS.has(dir)) {
        out.push(`${file}: "${dir}/" is not a module directory from architecture.md §3`);
      } else if (dir === "src/bootstrap" && name !== ".gitkeep" && !BOOTSTRAP_FILES.has(name)) {
        out.push(`${file}: bootstrap holds only ${[...BOOTSTRAP_FILES].join(", ")}`);
      }
    }
  }
  return out;
}

function listFiles(dir: string): string[] {
  const stdout = execFileSync(
    "git",
    ["-C", dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  return stdout.split("\0").filter((f) => f.length > 0 && existsSync(resolve(dir, f)));
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? ".");
  const violations = findViolations(listFiles(dir));
  if (violations.length > 0) {
    console.error(`check-structure: ${String(violations.length)} violation(s) in ${dir}`);
    for (const v of violations) console.error(`  ${v}`);
    process.exitCode = 1;
  } else {
    console.log(`check-structure: ok (${dir})`);
  }
}
