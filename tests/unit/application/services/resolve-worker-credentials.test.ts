import { expect, it } from "vitest";
import { resolveWorkerCredentials } from "../../../../src/application/services/resolve-worker-credentials.ts";
import { registerProfileSchema } from "../../../../src/application/contracts/profile-metadata.ts";
import { parseOmiSetting } from "../../../../src/application/contracts/omisetting.ts";

const settings = parseOmiSetting({
  version: 1,
  github: { token: "FAKE_GITHUB", gitUser: { name: "bot", email: "bot@example.com" } },
  profiles: [
    { id: "one", tool: "claude", auth: { type: "token", token: "FAKE_ONE" } },
    { id: "two", tool: "claude", auth: { type: "token", token: "FAKE_TWO" } },
    { id: "codex", tool: "codex", auth: { type: "login" } },
  ],
});
const entry = (id: string, home: string, tool = "claude-code") => ({
  metadata: {
    ...registerProfileSchema.parse({
      profileId: id,
      credentialRef: home,
      tool,
      accountGroupId: id,
      modelAllowlist: [],
    }),
    state: "ready" as const,
  },
  revision: 1,
  activeWorkers: 0,
});

const profiles = [entry("one", "/one"), entry("two", "/two"), entry("codex", "/codex", "codex")];

it("selects only credentials for the registered profile identity", () => {
  expect(resolveWorkerCredentials(settings, profiles, "claude-code", "/two")).toEqual({
    githubToken: "FAKE_GITHUB",
    token: "FAKE_TWO",
  });
  expect(resolveWorkerCredentials(settings, profiles, "codex", "/codex")).toEqual({
    githubToken: "FAKE_GITHUB",
  });
});
it("refuses unregistered stores", () => {
  expect(() => resolveWorkerCredentials(settings, profiles, "claude-code", "/missing")).toThrow(
    "SETTINGS_PROFILE_NOT_FOUND",
  );
});
it("refuses ambiguous stores", () => {
  expect(() =>
    resolveWorkerCredentials(settings, [...profiles, entry("two", "/one")], "claude-code", "/one"),
  ).toThrow("SETTINGS_PROFILE_NOT_FOUND");
});
