import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/application/contracts/project-config.js";
import {
  createInstallationDoctor,
  detectInterop,
  WSL_EXE_FALLBACK,
  type WslProbe,
} from "../../../src/infrastructure/processes/installation-doctor.js";
import { inspectInstallation } from "../../../src/application/use-cases/project/inspect-installation.js";

const request = { projectDir: "/home/user/project", distribution: "Ubuntu" };
const config = {
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 3 },
  policies: { mandatory_approvals: [], github_approval_actors: ["po-human"] },
} as unknown as ProjectConfig;

type Answers = Record<string, string | undefined>;
const defaults: Answers = {
  "gh auth status": "Logged in",
  "gh api user": JSON.stringify({ login: "agent-bot" }),
  "gh api users/po-human": JSON.stringify({ login: "po-human", type: "User" }),
  "gh api repos/acme/app": JSON.stringify({ permissions: { push: true } }),
  "gh api graphql": JSON.stringify({
    data: { repositoryOwner: { projectV2: { viewerCanUpdate: true } } },
  }),
  "claude --version": "2.1.322 (Claude Code)",
  "codex --version": "codex-cli 0.167.0",
  "session-runtime": "v24.0.0",
};

function probe(answers: Answers, projectConfig: ProjectConfig | null): WslProbe {
  const all = { ...defaults, ...answers };
  return {
    kernel: () => Promise.resolve("6.6.87-microsoft-standard-WSL2"),
    distro: () => "Ubuntu",
    interop: () => Promise.resolve(true),
    canonical: (path) => Promise.resolve(path),
    projectConfig: () => Promise.resolve(projectConfig ?? undefined),
    command: (executable, args) => {
      if (executable === "wsl.exe")
        return Promise.resolve(
          args[0] === "--list"
            ? "  NAME STATE VERSION\n* Ubuntu Running 2"
            : args.includes("--omi-node-exec")
              ? all["session-runtime"]
              : "0.0.0",
        );
      if (executable === "wslpath")
        return Promise.resolve(
          args[0] === "-w"
            ? "\\\\wsl.localhost\\Ubuntu\\home\\user\\project"
            : "/home/user/project",
        );
      const key = [executable, ...args.slice(0, 2)].join(" ");
      return Promise.resolve(all[key]);
    },
  };
}

async function run(answers: Answers = {}, projectConfig: ProjectConfig | null = config) {
  const report = await inspectInstallation(
    createInstallationDoctor(probe(answers, projectConfig)),
    request,
  );
  const status = (name: string) => report.checks.find((check) => check.name === name);
  return { report, status };
}

describe("doctor session runtime launch", () => {
  it("passes when the shim can start node", async () => {
    const { status } = await run();
    expect(status("session-runtime-launch")).toMatchObject({ ok: true });
  });
  it("fails by name when the shim cannot start node", async () => {
    const { report, status } = await run({ "session-runtime": undefined });
    expect(status("session-runtime-launch")).toMatchObject({ ok: false });
    expect(status("session-runtime-launch")?.fix).toContain("omi install --apply");
    expect(report.supported).toBe(false);
  });
});

describe("doctor GitHub and worker CLI checks", () => {
  it("passes with a distinct agent account, permissions and supported CLIs", async () => {
    const { report } = await run();
    expect(report.supported).toBe(true);
    expect(report.version).toBe(1);
    for (const check of report.checks) {
      expect(["pass", "fail"]).toContain(check.status);
      expect(check.fix.length).toBeGreaterThan(0);
    }
  });

  it("reports a missing gh login without reaching later GitHub checks", async () => {
    const { report, status } = await run({ "gh auth status": undefined });
    expect(report.supported).toBe(false);
    expect(status("github-auth")).toMatchObject({ ok: false, status: "fail" });
    expect(status("github-auth")?.fix).toContain("gh auth login");
    expect(status("github-agent-identity")?.ok).toBe(false);
  });

  it("fails when the gh account is a PO in the allowlist, case-insensitively", async () => {
    const { report, status } = await run({
      "gh api user": JSON.stringify({ login: "PO-Human" }),
    });
    expect(report.supported).toBe(false);
    expect(status("github-agent-identity")).toMatchObject({ ok: false });
    expect(status("github-agent-identity")?.fix).toContain("agent");
  });

  it("fails when the repository grants no push permission", async () => {
    const { status } = await run({
      "gh api repos/acme/app": JSON.stringify({ permissions: { push: false } }),
    });
    expect(status("github-repository-access")).toMatchObject({ ok: false });
  });

  it("fails when the Project cannot be updated", async () => {
    const { status } = await run({
      "gh api graphql": JSON.stringify({
        data: { repositoryOwner: { projectV2: { viewerCanUpdate: false } } },
      }),
    });
    expect(status("github-project-access")).toMatchObject({ ok: false });
    const missing = await run({ "gh api graphql": undefined });
    expect(missing.status("github-project-access")).toMatchObject({ ok: false });
  });

  it("fails when no allowlist entry is a User account", async () => {
    const { status } = await run({
      "gh api users/po-human": JSON.stringify({ login: "po-human", type: "Organization" }),
    });
    expect(status("github-approval-allowlist")).toMatchObject({ ok: false });
    const empty = await run({}, { ...config, policies: { mandatory_approvals: [] } });
    expect(empty.status("github-approval-allowlist")).toMatchObject({ ok: false });
  });

  it("fails every GitHub policy check when project.yaml is unreadable", async () => {
    const { status } = await run({}, null);
    expect(status("github-agent-identity")).toMatchObject({ ok: false });
    expect(status("github-repository-access")).toMatchObject({ ok: false });
    expect(status("github-project-access")).toMatchObject({ ok: false });
    expect(status("github-approval-allowlist")).toMatchObject({ ok: false });
  });

  it("never copies command output beyond the login into the report", async () => {
    const { report } = await run({ "gh auth status": "token: ghp_SECRET123" });
    expect(JSON.stringify(report)).not.toContain("ghp_SECRET123");
  });

  it.each([
    ["claude", "claude --version", "2.1.322 (Claude Code)", "supported", true],
    ["claude", "claude --version", "2.1.400 (Claude Code)", "supported", true],
    ["claude", "claude --version", "2.2.0 (Claude Code)", "untested", false],
    ["claude", "claude --version", "2.1.100 (Claude Code)", "unsupported", false],
    ["claude", "claude --version", "garbage", "unsupported", false],
    ["codex", "codex --version", "codex-cli 0.167.0", "supported", true],
    ["codex", "codex --version", "codex-cli 0.168.0", "untested", false],
    ["codex", "codex --version", "codex-cli 0.166.9", "unsupported", false],
  ] as const)("classifies %s %s %s as %s", async (cli, key, output, classification, ok) => {
    const other = cli === "claude" ? "codex --version" : "claude --version";
    const { status } = await run({ [key]: output, [other]: undefined });
    const check = status(`worker-cli-${cli}`);
    expect(check).toMatchObject({ classification, ok });
    expect(check?.detail).toContain(classification);
  });

  it("warns without failing when one CLI is absent, but fails when both are", async () => {
    const one = await run({ "codex --version": undefined });
    expect(one.status("worker-cli-codex")).toMatchObject({ classification: "not-installed" });
    expect(one.status("worker-cli-available")?.ok).toBe(true);
    const none = await run({ "codex --version": undefined, "claude --version": undefined });
    expect(none.status("worker-cli-available")?.ok).toBe(false);
  });
});

describe("doctor WSL interop and wsl.exe reachability", () => {
  const io = (entries: Record<string, string>, hasSocket = true) => ({
    socket: hasSocket ? "/run/WSL/1_interop" : undefined,
    access: () => Promise.resolve(),
    readdir: () => Promise.resolve(Object.keys(entries)),
    readFile: (path: string) => {
      const text = entries[path.split("/").at(-1) ?? ""];
      return text === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(text);
    },
  });

  it("accepts an enabled WSLInterop-late entry", async () => {
    expect(await detectInterop(io({ "WSLInterop-late": "enabled\ninterpreter /init" }))).toBe(true);
  });

  it("still fails when every WSLInterop entry is disabled", async () => {
    expect(await detectInterop(io({ "WSLInterop-late": "disabled", WSLInterop: "disabled" }))).toBe(
      false,
    );
  });

  it("fails without WSLInterop entries or without the socket", async () => {
    expect(await detectInterop(io({ python3: "enabled" }))).toBe(false);
    expect(await detectInterop(io({ WSLInterop: "enabled" }, false))).toBe(false);
  });

  it("falls back to the absolute wsl.exe path when PATH lacks it", async () => {
    const base = probe({}, config);
    const calls: string[] = [];
    const p: WslProbe = {
      ...base,
      command: (executable, args, cwd) => {
        calls.push(executable);
        if (executable === "wsl.exe") return Promise.resolve(undefined);
        return base.command(executable === WSL_EXE_FALLBACK ? "wsl.exe" : executable, args, cwd);
      },
    };
    const report = await inspectInstallation(createInstallationDoctor(p), request);
    const status = (name: string) => report.checks.find((c) => c.name === name);
    expect(calls).toContain(WSL_EXE_FALLBACK);
    expect(status("wsl-exe")?.ok).toBe(true);
    expect(status("distribution-version")?.ok).toBe(true);
    expect(status("windows-launch")?.ok).toBe(true);
  });

  it("reports wsl.exe as unreachable without blaming the version or the shim", async () => {
    const base = probe({}, config);
    const p: WslProbe = {
      ...base,
      command: (executable, args, cwd) =>
        executable === "wsl.exe" || executable === WSL_EXE_FALLBACK
          ? Promise.resolve(undefined)
          : base.command(executable, args, cwd),
    };
    const report = await inspectInstallation(createInstallationDoctor(p), request);
    const status = (name: string) => report.checks.find((c) => c.name === name);
    expect(report.supported).toBe(false);
    expect(status("wsl-exe")).toMatchObject({ ok: false });
    expect(status("wsl-exe")?.fix).toContain("appendWindowsPath");
    for (const name of ["distribution-version", "windows-launch"]) {
      expect(status(name)?.ok).toBe(false);
      expect(status(name)?.fix).not.toContain("--set-version");
      expect(status(name)?.fix).not.toContain("Reinstall");
      expect(status(name)?.fix).toContain("wsl-exe");
    }
  });
});
