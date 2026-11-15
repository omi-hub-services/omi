import { expect, it } from "vitest";
import { loadOmiSetting } from "../../../src/infrastructure/config/load-omisetting.js";
import {
  parseOmiSetting,
  settingsCredentialPolicy,
} from "../../../src/application/contracts/omisetting.js";
import { dockerRuntimeEnvironment } from "../../../src/infrastructure/config/docker-runtime-environment.js";
import { assertCredentialFree } from "../../../src/application/contracts/credential-input.js";
import { buildClaudeCodeEnvironment } from "../../../src/infrastructure/executors/claude-code/claude-code-environment.js";
import * as environment from "../../../src/infrastructure/config/docker-runtime-environment.js";

it("loads Docker runtime credentials from process env without a project settings file", async () => {
  const metadata = {
    version: 1,
    github: { token: "", gitUser: { name: "bot", email: "bot@example.com" } },
    profiles: [{ id: "claude-main", tool: "claude", auth: { type: "token", token: "" } }],
    docker: {},
  };
  const settings = await loadOmiSetting("/does-not-exist/omi-docker", {
    OMI_DOCKER_RUNTIME: "1",
    OMI_DOCKER_SETTINGS: JSON.stringify(metadata),
    GH_TOKEN: "fake-github-relay",
    OMI_DOCKER_PROFILE_TOKEN_0: "fake-claude-relay",
  });
  expect(settings?.github.token).toBe("fake-github-relay");
  expect(settings?.profiles[0]?.auth).toEqual({ type: "token", token: "fake-claude-relay" });
});

it("guards received tokens and isolates the selected worker environment", async () => {
  const original = parseOmiSetting({
    version: 1,
    github: { token: "fake-github-relay", gitUser: { name: "bot", email: "bot@example.com" } },
    profiles: [
      { id: "a", tool: "claude", auth: { type: "token", token: "fake-token-a" } },
      { id: "b", tool: "claude", auth: { type: "token", token: "fake-token-b" } },
    ],
    docker: {},
  });
  const env: Record<string, string> = {
    ...dockerRuntimeEnvironment(original),
    OMI_DOCKER_RUNTIME: "1",
  };
  const restored = await loadOmiSetting("/missing-project", env);
  expect(restored).toEqual(original);
  if (restored === undefined) throw new Error("Expected in-memory Docker settings");
  for (const token of ["fake-token-a", "fake-token-b", original.github.token])
    expect(() => {
      assertCredentialFree({ summary: token }, settingsCredentialPolicy(restored));
    }).toThrow();
  const worker = buildClaudeCodeEnvironment(env, "/work/.profiles/a", {
    token: "fake-token-a",
    githubToken: original.github.token,
  });
  expect(worker.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-token-a");
  expect(Object.values(worker)).not.toContain("fake-token-b");
  expect(worker.OMI_DOCKER_SETTINGS).toBeUndefined();
});

it("fails closed when a runtime token slot is absent", async () => {
  const original = parseOmiSetting({
    version: 1,
    github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
    profiles: [{ id: "a", tool: "claude", auth: { type: "token", token: "fake-token" } }],
    docker: {},
  });
  const env: Record<string, string> = {
    ...dockerRuntimeEnvironment(original),
    OMI_DOCKER_RUNTIME: "1",
  };
  delete env["OMI_DOCKER_PROFILE_TOKEN_0"];
  await expect(loadOmiSetting("/missing-project", env)).rejects.toThrow("profiles[0].auth.token");
});

it("refuses missing or secret-bearing metadata without echoing it", async () => {
  await expect(loadOmiSetting("/missing-project", { OMI_DOCKER_RUNTIME: "1" })).rejects.toThrow(
    "settings: missing runtime metadata",
  );
  await expect(
    loadOmiSetting("/missing-project", {
      OMI_DOCKER_RUNTIME: "1",
      OMI_DOCKER_SETTINGS: '{"github":{"token":"fake-private"}}',
    }),
  ).rejects.toThrow("github.token: runtime metadata must use a placeholder");
});

it("keeps profile relay slots out of Git and GitHub service children", () => {
  expect(environment.dockerServiceEnvironment, "service child credential isolation").toBeTypeOf(
    "function",
  );
  const child = environment.dockerServiceEnvironment({
    PATH: "/bin",
    GH_TOKEN: "fake-github",
    OMI_DOCKER_SETTINGS: "metadata",
    OMI_DOCKER_PROFILE_TOKEN_0: "fake-profile",
  });
  expect(child).toEqual({ PATH: "/bin", GH_TOKEN: "fake-github" });
});
