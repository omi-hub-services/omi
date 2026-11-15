import {
  REPOSITORY_WORKER_ALLOWED_TOOLS,
  REPOSITORY_WORKER_DENIED_TOOLS,
} from "../executors/claude-code/claude-code-invocation.js";

export interface RepositoryWorkerSpec {
  readonly task: string;
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
  readonly resume: string | null;
  readonly packet: string;
}

export function repositoryWorkerArgs(
  kind: "claude" | "codex",
  spec: RepositoryWorkerSpec,
): string[] {
  if (
    !/^\d{1,6}$/.test(spec.task) ||
    [
      spec.profile,
      spec.model,
      spec.effort,
      spec.packet,
      ...(spec.resume === null ? [] : [spec.resume]),
    ].some((word) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(word))
  )
    throw new Error("Invalid worker spec");
  return kind === "claude"
    ? [
        "claude",
        "-p",
        "--disable-slash-commands",
        "--model",
        spec.model,
        "--effort",
        spec.effort,
        ...(spec.resume === null ? [] : ["--resume", spec.resume]),
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "200",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        ...REPOSITORY_WORKER_ALLOWED_TOOLS,
        "--disallowedTools",
        ...REPOSITORY_WORKER_DENIED_TOOLS,
      ]
    : [
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
}
