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

  it("redacts credential-shaped keys in the issue path", () => {
    const parsed = z.object({ models: z.record(z.string(), z.number()) }).safeParse({
      models: { api_key_prod: "x", ghp_abcdefghijklmnopqrstuvwxyz0123456789: "x", worker: "x" },
    });
    if (parsed.success) throw new Error("expected failure");
    const text = presentStartupError(parsed.error);
    expect(text).not.toContain("api_key_prod");
    expect(text).not.toContain("ghp_");
    expect(text).toContain("models.[redacted]");
    expect(text).toContain("models.worker");
  });

  it("does not echo an interpolated model alias or other quoted value", () => {
    const parsed = z
      .string()
      .superRefine((_, ctx) => {
        ctx.addIssue({ code: "custom", message: 'unknown model alias "private-corp-alias"' });
      })
      .safeParse("x");
    if (parsed.success) throw new Error("expected failure");
    const text = presentStartupError(parsed.error);
    expect(text).toContain("unknown model alias");
    expect(text).not.toContain("private-corp-alias");
  });

  it("redacts Bearer tokens in a message", () => {
    const parsed = z
      .string()
      .refine(() => false, { message: "rejected Bearer abcdefghijklmnop1234" })
      .safeParse("x");
    if (parsed.success) throw new Error("expected failure");
    const text = presentStartupError(parsed.error);
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).toContain("[redacted]");
  });

  it("maps fixed-code config errors to CONFIG_INVALID", () => {
    for (const code of ["INVALID_MODELS_CONFIG", "PROJECT_NOT_CONFIGURED"])
      expect(presentStartupError(new Error(code))).toBe(
        `omi runtime startup failed [CONFIG_INVALID]: ${code}\n`,
      );
  });

  it("prints other fixed-code errors by code only", () => {
    expect(presentStartupError(new Error("UNKNOWN_ATTEMPT"))).toContain("UNKNOWN_ATTEMPT");
  });

  it("does not print the message of a catalog load error", () => {
    const error = Object.assign(new Error("failed: /home/u/secret-file contents"), {
      name: "CatalogLoadError",
    });
    const text = presentStartupError(error);
    expect(text).toContain("[CONFIG_INVALID]");
    expect(text).not.toContain("secret-file");
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
