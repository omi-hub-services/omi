// Pure part of `flow.ts dispatch` (OMI-077): which curated skills a worker prompt gets and the
// exact `bash -lc` payload that launches Claude or Codex (omi-next step 3). Nothing here runs a
// process. Payloads contain no `"`, `\` or newline (wsl.exe rewrites them, process-runner.ts).
import { shellQuote, WSL_NODE_ENV } from "./process-runner.ts";
import { RUNS_DIR_FROM_HOME } from "./coordinator-settings.ts";

import "../register-ts-imports.ts";
const { REPOSITORY_WORKER_ALLOWED_TOOLS, REPOSITORY_WORKER_DENIED_TOOLS } =
  await import("../../src/infrastructure/executors/claude-code/claude-code-invocation.ts");
export const CLAUDE_ALLOWED_TOOLS = REPOSITORY_WORKER_ALLOWED_TOOLS;
export const CLAUDE_DENIED_TOOLS = REPOSITORY_WORKER_DENIED_TOOLS;

export const NATIVE_RESUME_HEADER = "# Native resume only";

/** `$HOME/omi-runs/omi-<task>-<suffix>`; `task` is the digits of the Plan Key. */
export function runsPath(task: string, suffix: string): string {
  assertTask(task);
  return `$HOME/${RUNS_DIR_FROM_HOME}/omi-${task}-${suffix}`;
}

export interface LaunchSpec {
  /** Digits of the Plan Key (OMI-077 -> "077"). */
  readonly task: string;
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
  /** Claude session id or Codex thread id; null starts a new run. */
  readonly resume: string | null;
}

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const assertTask = (task: string) => {
  if (!/^\d{1,6}$/.test(task)) throw new Error(`invalid task "${task}"`);
};
function assertSpec(spec: LaunchSpec): void {
  assertTask(spec.task);
  for (const key of ["profile", "model", "effort"] as const) {
    if (!WORD.test(spec[key])) throw new Error(`invalid ${key} "${spec[key]}"`);
  }
  if (spec.resume !== null && !WORD.test(spec.resume)) {
    throw new Error(`invalid resume id "${spec.resume}"`);
  }
}

const TS = "ts=$(date +%Y%m%d-%H%M%S);";
const redirects = (task: string, stem: string) =>
  `< ${runsPath(task, "prompt.md")} > ${runsPath(task, `${stem}-$ts.jsonl`)} 2> ${runsPath(task, `${stem}-$ts.err`)}; echo exit=$?`;

export function claudeLaunchPayload(spec: LaunchSpec): string {
  assertSpec(spec);
  const resume = spec.resume === null ? [] : ["--resume", spec.resume];
  const argv = [
    "claude",
    "-p",
    "--disable-slash-commands",
    "--model",
    spec.model,
    "--effort",
    spec.effort,
    ...resume,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "200",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...CLAUDE_ALLOWED_TOOLS,
    "--disallowedTools",
    ...CLAUDE_DENIED_TOOLS,
  ];
  return [
    WSL_NODE_ENV,
    `export CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/${spec.profile};`,
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;",
    TS,
    argv.map(shellQuote).join(" "),
    redirects(spec.task, spec.profile),
  ].join(" ");
}

/** `-s`, `-m`, `-c` and `-o` come before `resume` so they are parsed as `exec` options. */
export function codexLaunchPayload(spec: LaunchSpec): string {
  assertSpec(spec);
  const argv = [
    "codex",
    "exec",
    "--json",
    "-s",
    "workspace-write",
    "-m",
    spec.model,
    "-c",
    `model_reasoning_effort=${spec.effort}`,
  ];
  const resume = spec.resume === null ? [] : ["resume", spec.resume];
  return [
    WSL_NODE_ENV,
    `export CODEX_HOME=$HOME/.codex-profiles/${spec.profile};`,
    TS,
    argv.map(shellQuote).join(" "),
    `-o ${runsPath(spec.task, "codex-last.md")}`,
    [...resume, "-"].join(" "),
    redirects(spec.task, `codex-${spec.profile}`),
  ].join(" ");
}
