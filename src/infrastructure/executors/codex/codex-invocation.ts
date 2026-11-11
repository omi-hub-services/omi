import type { ExecutionRequest } from "../../../application/contracts/agent-execution.js";

/** ADR-0023 amendment: identity effort mapping; unsupported choices are never downgraded. */
export function buildCodexInvocationArgs(request: ExecutionRequest, outputPath: string): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "-c",
    'approval_policy="never"',
    "-m",
    request.model,
    "-c",
    `model_reasoning_effort=${request.effort}`,
    "-C",
    request.workspace,
    "-s",
    request.access,
    "-o",
    outputPath,
    "-",
  ];
}
