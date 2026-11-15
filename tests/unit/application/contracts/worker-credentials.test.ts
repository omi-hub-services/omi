import { expect, it } from "vitest";
import { buildClaudeCodeEnvironment } from "../../../../src/infrastructure/executors/claude-code/claude-code-environment.ts";
import { buildCodexEnvironment } from "../../../../src/infrastructure/executors/codex/codex-environment.ts";

it("passes only the selected credentials and discards parent authentication", () => {
  const parent = {
    PATH: "/bin",
    GH_TOKEN: "fake-parent-github",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-other-profile",
    OPENAI_API_KEY: "fake-api",
  };
  const selected = { githubToken: "fake-selected-github", token: "fake-selected-claude" };
  expect(buildClaudeCodeEnvironment(parent, "/profile", selected)).toMatchObject({
    GH_TOKEN: selected.githubToken,
    CLAUDE_CODE_OAUTH_TOKEN: selected.token,
  });
  expect(buildCodexEnvironment(parent, "/codex", selected)).toEqual({
    PATH: "/bin",
    CODEX_HOME: "/codex",
    GH_TOKEN: selected.githubToken,
  });
});

it("accepts setup-token auth only when the selected profile supplied the token", async () => {
  const { interpretAuthStatus } =
    await import("../../../../src/infrastructure/executors/claude-code/claude-code-probe.ts");
  const output = JSON.stringify({
    loggedIn: true,
    authMethod: "oauth_token",
    apiProvider: "firstParty",
  });
  expect(interpretAuthStatus(output, true).status).toBe("ready");
  expect(interpretAuthStatus(output).status).toBe("unsupported-auth-mode");
});
