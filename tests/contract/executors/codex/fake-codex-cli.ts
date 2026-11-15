import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function fixture(name: string): string {
  return readFileSync(
    resolve(import.meta.dirname, "../../../fixtures/executors/codex", name),
    "utf8",
  );
}

export interface FakeCodexScenario {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  finalMessage?: string;
  outputKind?: "missing" | "oversized" | "symlink" | "directory" | "invalid-utf8";
  behaviour?: "replay" | "wait-for-sigint" | "ignore-sigint";
  onSigint?: string;
  versionOutput?: string;
  versionExitCode?: number;
}

export interface Invocation {
  argv: string[];
  cwd: string;
  envKeys: string[];
  codexHome: string;
  stdin: string;
}

/** An executable stand-in: no real CLI, network, auth commands or model quota. */
export function writeFakeCodex(
  dir: string,
  name: string,
  scenario: FakeCodexScenario,
  recordPath: string,
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    String.raw`#!/usr/bin/env node
import { appendFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const recordPath = ${JSON.stringify(recordPath)};
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  appendFileSync(recordPath, JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME, stdin }) + "\n");
  if (argv[0] === "--version") {
    process.stdout.write(scenario.versionOutput ?? "codex-cli 0.167.0\n");
    process.exitCode = scenario.versionExitCode ?? 0;
    return;
  }
  if (argv[0] !== "exec") throw new Error("unexpected fake invocation");
  const outputPath = argv[argv.indexOf("-o") + 1];
  if (scenario.outputKind === "directory") mkdirSync(outputPath);
  else if (scenario.outputKind === "symlink") symlinkSync(recordPath, outputPath);
  else if (scenario.outputKind === "oversized") writeFileSync(outputPath, "x".repeat(400001));
  else if (scenario.outputKind === "invalid-utf8") writeFileSync(outputPath, Buffer.from([0xff]));
  else if (scenario.outputKind !== "missing") writeFileSync(outputPath, scenario.finalMessage ?? "The codename is BLUE-HERON-42.");
  const behaviour = scenario.behaviour ?? "replay";
  // Install handlers BEFORE stdout, so a consumer can cancel immediately on 'started'.
  if (behaviour === "wait-for-sigint") {
    process.on("SIGINT", () => { process.stdout.write(scenario.onSigint ?? "", () => process.exit(1)); });
  } else if (behaviour === "ignore-sigint") process.on("SIGINT", () => undefined);
  process.stdout.write(scenario.stdout ?? "");
  process.stderr.write(scenario.stderr ?? "");
  if (behaviour === "replay") { process.exitCode = scenario.exitCode ?? 0; return; }
  setInterval(() => undefined, 1000);
});
`,
  );
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
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}
