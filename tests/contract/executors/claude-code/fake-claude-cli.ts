// A stand-in `claude` executable for contract tests: it replays fixture output and records how
// it was invoked. It never contacts a model and needs no login.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const fixtureDir = resolve(import.meta.dirname, "../../../fixtures/executors/claude-code");

export function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

export interface FakeClaudeScenario {
  /** What `claude -p ...` writes to stdout and stderr. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /**
   * `replay` prints and exits. `wait-for-sigint` prints `stdout`, then on SIGINT prints `onSigint`
   * and exits 0 (the proven cancel behaviour). `ignore-sigint` prints `stdout` and never exits.
   */
  behaviour?: "replay" | "wait-for-sigint" | "ignore-sigint";
  onSigint?: string;
  /**
   * Rewrites the replayed `system/init` line the way the CLI reports its startup state (OMI-072
   * probe on 2.1.322): `--disable-slash-commands` empties `skills`; plugins come from the `user`
   * settings source; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` removes the profile's auto-memory path.
   * A model of the documented behaviour, not a recording.
   */
  initFromLaunch?: boolean;
  /** `claude --version`. */
  versionOutput?: string;
  versionExitCode?: number;
  /** `claude auth status --json`. */
  authStatusOutput?: string;
  authStatusExitCode?: number;
}

export interface Invocation {
  kind: "run" | "version" | "auth";
  argv: string[];
  cwd: string;
  envKeys: string[];
  claudeConfigDir: string | undefined;
  disableAutoMemory: string | undefined;
  disableAutoUpdater: string | undefined;
  stdin: string;
}

/** Writes an executable fake CLI into `dir`; invocations are appended to `recordPath` as JSONL. */
export function writeFakeClaude(
  dir: string,
  name: string,
  scenario: FakeClaudeScenario,
  recordPath: string,
): string {
  const path = join(dir, name);
  const source = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const recordPath = ${JSON.stringify(recordPath)};
const argv = process.argv.slice(2);
const kind = argv[0] === "--version" ? "version" : argv[0] === "auth" ? "auth" : "run";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  appendFileSync(
    recordPath,
    JSON.stringify({
      kind,
      argv,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env).sort(),
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      disableAutoUpdater: process.env.DISABLE_AUTOUPDATER,
      disableAutoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      stdin,
    }) + "\\n",
  );
  if (kind === "version") {
    process.stdout.write(scenario.versionOutput ?? "");
    process.exit(scenario.versionExitCode ?? 0);
  }
  if (kind === "auth") {
    process.stdout.write(scenario.authStatusOutput ?? "");
    process.exit(scenario.authStatusExitCode ?? 0);
  }
  const behaviour = scenario.behaviour ?? "replay";
  // The handler must exist before the first byte of stdout: a test waits for the first event and
  // then cancels, and a SIGINT that lands earlier would take the default action and kill us.
  if (behaviour === "wait-for-sigint") {
    process.on("SIGINT", () => {
      process.stdout.write(scenario.onSigint ?? "", () => process.exit(0));
    });
  } else if (behaviour === "ignore-sigint") {
    process.on("SIGINT", () => undefined);
  }
  const launchInit = (line) => {
    if (!scenario.initFromLaunch || !line.includes('"subtype":"init"')) return line;
    const event = JSON.parse(line);
    const sourcesIndex = argv.indexOf("--setting-sources");
    const sources = (sourcesIndex < 0 ? "user,project,local" : argv[sourcesIndex + 1]).split(",");
    const config = process.env.CLAUDE_CONFIG_DIR ?? "";
    event.skills = argv.includes("--disable-slash-commands") ? [] : ["fixture-skill"];
    event.plugins = sources.includes("user")
      ? [{ name: "fixture-plugin", path: config + "/plugins/fixture-plugin" }]
      : [];
    event.memory_paths =
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1"
        ? {}
        : { auto: config + "/projects/fixture/memory/" };
    return JSON.stringify(event);
  };
  process.stdout.write((scenario.stdout ?? "").split("\\n").map(launchInit).join("\\n"));
  process.stderr.write(scenario.stderr ?? "");
  if (behaviour === "replay") {
    process.exitCode = scenario.exitCode ?? 0;
    return;
  }
  setInterval(() => undefined, 1000);
});
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

export function readInvocations(recordPath: string): Invocation[] {
  let text: string;
  try {
    text = readFileSync(recordPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Invocation);
}
