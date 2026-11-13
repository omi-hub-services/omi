import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GitWorkspaceError } from "../../../../src/application/ports/git-workspace.ts";
import {
  RuntimeStartupError,
  presentStartupError,
} from "../../../../src/interfaces/cli/presenters/startup-error-presenter.ts";

describe("presentStartupError", () => {
  it("classifies a Zod config error with issue path and message only", () => {
    const parsed = z
      .object({ deploy_targets: z.array(z.object({ name: z.string() })) })
      .safeParse({ deploy_targets: [{ name: 42 }] });
    if (parsed.success) throw new Error("expected failure");
    const text = presentStartupError(parsed.error);
    expect(text).toContain("CONFIG_INVALID");
    expect(text).toContain("deploy_targets.0.name");
    expect(text).not.toContain("42");
    expect(text).not.toContain(" at ");
  });

  it("prints the GitWorkspaceError code", () => {
    const text = presentStartupError(new GitWorkspaceError("GIT_FAILED"));
    expect(text).toContain("GIT_WORKSPACE_FAILED");
    expect(text).toContain("GIT_FAILED");
  });

  it("classifies path errors, including filesystem errno codes", () => {
    expect(presentStartupError(new RuntimeStartupError("PATH_INVALID", "not absolute"))).toContain(
      "PATH_INVALID",
    );
    const errno = Object.assign(new Error("EACCES: permission denied, mkdir '/secret/path'"), {
      code: "EACCES",
    });
    const text = presentStartupError(errno);
    expect(text).toContain("PATH_ERROR");
    expect(text).toContain("EACCES");
  });

  it("never prints stacks, tokens or raw messages of unknown errors", () => {
    const text = presentStartupError(new Error("boom ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    expect(text).toContain("RUNTIME_STARTUP_FAILED");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("boom");
    expect(text).not.toContain("node:");
  });

  it("redacts secret-looking values inside a Zod message", () => {
    const parsed = z
      .string()
      .refine(() => false, { message: "bad ghp_abcdefghijklmnopqrstuvwxyz0123456789" })
      .safeParse("x");
    if (parsed.success) throw new Error("expected failure");
    expect(presentStartupError(parsed.error)).not.toContain("ghp_");
  });
});
