import { expect, it } from "vitest";
import { parseOmiSetting } from "../../../../src/application/contracts/omisetting.js";

it("accepts bounded Docker doctor thresholds", () => {
  const settings = parseOmiSetting({
    version: 1,
    github: { token: "fake", gitUser: { name: "test", email: "test@example.com" } },
    profiles: [{ id: "test", tool: "codex", auth: { type: "login" } }],
    docker: { memoryWarningPercent: 70, workVolumeWarningGb: 10 },
  });
  expect(settings.docker?.memoryWarningPercent).toBe(70);
});

it.each([
  { container: "--privileged" },
  { image: "untrusted:latest" },
  { memoryWarningPercent: 101 },
  { workVolumeWarningGb: 0 },
])("rejects invalid Docker configuration", (docker) => {
  expect(() =>
    parseOmiSetting({
      version: 1,
      github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
      profiles: [{ id: "test", tool: "codex", auth: { type: "login" } }],
      docker,
    }),
  ).toThrow();
});
