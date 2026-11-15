import { describe, expect, it, vi } from "vitest";
import { installProjectTool } from "../../../../../src/application/use-cases/project/install-project-tool.js";
import type { FrameworkLock } from "../../../../../src/application/contracts/project-installation.js";

const request = { projectDir: "/project", distribution: "Ubuntu", version: "0.3.0" };
const notes = `# Changelog
## [0.4.0] - 2026-11-14
### Breaking
- Future change
## [0.3.0] - 2026-11-13
### Added
- Latest feature
### Breaking
## [0.2.0] - 2026-11-12
### Breaking
- Change config
### Fixed
- Intermediate fix
## [0.1.0] - 2026-11-11
### Breaking
- Old change
`;

it("refuses changes to an installed Docker binding", async () => {
  for (const changed of [
    { projectDir: "/relocated", docker: { container: "omi-project" } },
    { projectDir: "/project", docker: { container: "omi-other" } },
  ]) {
    for (const apply of [false, true]) {
      const h = setup();
      const snapshot = await h.store.inspect();
      const installed = {
        ...snapshot.installed,
        distribution: undefined,
        docker: { container: "omi-project" },
      };
      h.store.inspect.mockResolvedValue({
        ...snapshot,
        installed,
        candidate: { ...installed, ...changed },
      });
      await expect(
        installProjectTool(h.store, {
          projectDir: changed.projectDir,
          packageDir: "/offline",
          apply,
        }),
      ).rejects.toThrow("PROJECT_BINDING_CHANGED");
      expect(h.store.apply).not.toHaveBeenCalled();
    }
  }
});

it("updates an unchanged Docker binding", async () => {
  const h = setup();
  const snapshot = await h.store.inspect();
  const installed = {
    ...snapshot.installed,
    distribution: undefined,
    docker: { container: "omi-project" },
  };
  h.store.inspect.mockResolvedValue({ ...snapshot, installed, candidate: installed });
  expect(
    (
      await installProjectTool(h.store, {
        projectDir: "/project",
        packageDir: "/offline",
        apply: true,
      })
    ).status,
  ).toBe("installed");
});

function setup(changelog = notes, installedVersion = "0.1.0") {
  const lock = (version: string): FrameworkLock => ({
    ...request,
    schemaVersion: 1,
    version,
    artifactHash: "a".repeat(64),
    base: { "rules/example.md": version },
  });
  const installed = lock(installedVersion);
  const store = {
    assertDirectory: vi.fn<(projectDir: string) => Promise<void>>(() => Promise.resolve()),
    inspect: vi.fn(() =>
      Promise.resolve({ installed, candidate: lock("0.3.0"), local: installed.base }),
    ),
    apply: vi.fn<(plan: unknown) => Promise<{ backupDir: string }>>(() =>
      Promise.resolve({ backupDir: "/backup" }),
    ),
  };
  const cleanup = vi.fn(async () => {});
  const releases = {
    prepare: vi.fn(() => Promise.resolve({ packageDir: "/release/package", changelog, cleanup })),
  };
  return { store, releases, cleanup };
}

describe("release installation", () => {
  it("refuses a legacy directory before downloading a release", async () => {
    const h = setup();
    h.store.assertDirectory.mockRejectedValue(new Error("run omi migrate-dir"));
    await expect(installProjectTool(h.store, request, h.releases)).rejects.toThrow(
      "omi migrate-dir",
    );
    expect(h.releases.prepare).not.toHaveBeenCalled();
  });
  it("accepts an empty final Breaking section without a trailing newline", async () => {
    const h = setup("## [0.3.0] - 2026-11-13\n### Added\n- Feature\n### Breaking");
    const result = await installProjectTool(h.store, request, h.releases);
    expect(result.status).toBe("preview");
    expect(result.breaking).toBe(false);
  });
  it("previews only entries after the installed version through the requested version", async () => {
    const h = setup();
    const result = await installProjectTool(h.store, request, h.releases);
    expect(result.status).toBe("preview");
    expect(result.changelog).toContain("Latest feature");
    expect(result.changelog).toContain("Change config");
    expect(result.changelog).not.toContain("Old change");
    expect(result.changelog).not.toContain("Future change");
    expect(result.breaking).toBe(true);
    expect(result.changes).toEqual(["rules/example.md"]);
    expect(h.store.apply).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it("blocks applying intermediate breaking changes before any installation write", async () => {
    const h = setup();
    await expect(
      installProjectTool(h.store, { ...request, apply: true }, h.releases),
    ).rejects.toThrow("BREAKING_CHANGES_REQUIRE_ACCEPTANCE");
    expect(h.store.apply).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it("applies accepted breaking updates through the existing package plan", async () => {
    const h = setup();
    expect(
      (
        await installProjectTool(
          h.store,
          { ...request, apply: true, acceptBreaking: true },
          h.releases,
        )
      ).status,
    ).toBe("installed");
    expect(h.store.apply.mock.calls[0]?.[0]).toMatchObject({
      input: { packageDir: "/release/package" },
      merged: { "rules/example.md": "0.3.0" },
    });
  });
  it("applies an update with empty Breaking sections without acceptance", async () => {
    const h = setup(notes.replace("- Change config", ""));
    expect(
      (await installProjectTool(h.store, { ...request, apply: true }, h.releases)).status,
    ).toBe("installed");
  });
  it.each(["0.3.0", "0.10.0", "1.0.0"])(
    "refuses same version or downgrade from %s",
    async (version) => {
      const h = setup(notes, version);
      await expect(installProjectTool(h.store, request, h.releases)).rejects.toThrow(
        "VERSION_NOT_NEWER",
      );
      expect(h.store.apply).not.toHaveBeenCalled();
      expect(h.cleanup).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "",
    notes.replace("### Breaking\n- Change config", "### Changes\n- Change config"),
    notes + "\n## [0.3.0] - 2026-11-13\n### Breaking\n",
  ])("fails closed for incomplete or duplicate release notes", async (changelog) => {
    const h = setup(changelog);
    await expect(installProjectTool(h.store, request, h.releases)).rejects.toThrow(
      "INVALID_RELEASE_CHANGELOG",
    );
    expect(h.store.apply).not.toHaveBeenCalled();
  });
  it("refuses a package whose metadata differs from the requested version", async () => {
    const h = setup();
    await expect(
      installProjectTool(h.store, { ...request, version: "0.4.0" }, h.releases),
    ).rejects.toThrow("RELEASE_VERSION_MISMATCH");
  });
  it("propagates download failure without inspecting or applying the project", async () => {
    const h = setup();
    h.releases.prepare.mockRejectedValue(new Error("RELEASE_DOWNLOAD_FAILED"));
    await expect(installProjectTool(h.store, request, h.releases)).rejects.toThrow(
      "RELEASE_DOWNLOAD_FAILED",
    );
    expect(h.store.inspect).not.toHaveBeenCalled();
  });
  it("keeps offline package installation available", async () => {
    const h = setup();
    expect(
      (
        await installProjectTool(h.store, {
          projectDir: request.projectDir,
          distribution: request.distribution,
          packageDir: "/offline",
          apply: true,
        })
      ).status,
    ).toBe("installed");
    expect(h.releases.prepare).not.toHaveBeenCalled();
  });
  it.each([{ packageDir: "/offline" }, { version: "../bad" }, { version: "v0.3.0" }])(
    "rejects ambiguous or invalid release input: %j",
    async (extra) => {
      const h = setup();
      await expect(
        installProjectTool(h.store, { ...request, ...extra }, h.releases),
      ).rejects.toThrow();
      expect(h.releases.prepare).not.toHaveBeenCalled();
    },
  );
});
