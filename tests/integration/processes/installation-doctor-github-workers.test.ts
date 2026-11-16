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
  branches: { integration: "develop", release: "main" },
  checks: { ci: { command: ["npm", "test"], timeout_seconds: 600 } },
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
    settings: () =>
      Promise.resolve({
        version: 1,
        github: { token: "fake-github", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "codex-main", tool: "codex", auth: { type: "login" } }],
      }),
    kernel: () => Promise.resolve("6.6.87-microsoft-standard-WSL2"),
    distro: () => "Ubuntu",
    interop: () => Promise.resolve(true),
    canonical: (path) => Promise.resolve(path),
    projectConfig: () => Promise.resolve(projectConfig ?? undefined),
    command: (executable, args) => {
      if (executable === "git") return Promise.resolve("");
      if (executable === "codex" && args[0] === "login")
        return Promise.resolve("Logged in using ChatGPT");
      if (executable === "wsl.exe")
        return Promise.resolve(
          args[0] === "--list"
            ? "  NAME STATE VERSION\n* Ubuntu Running 2"
            : args.includes("--omi-node-version")
              ? all["session-runtime"]
              : args.includes("--omi-worker-version")
                ? all[`${args.at(-1) ?? ""} --version`]
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
  it("checks workers with typed wsl shim argv even when they are absent from the current shell", async () => {
    const base = probe({ "claude --version": undefined, "codex --version": undefined }, config);
    const workerCalls: string[][] = [];
    const doctor = createInstallationDoctor({
      ...base,
      command: (executable, args, cwd) => {
        if (args.includes("--omi-worker-version")) {
          workerCalls.push([executable, ...args]);
          return Promise.resolve(
            args.at(-1) === "claude" ? "2.1.322 (Claude Code)" : "codex-cli 0.167.0",
          );
        }
        return base.command(executable, args, cwd);
      },
    });
    expect((await inspectInstallation(doctor, request)).supported).toBe(true);
    expect(workerCalls).toEqual(
      ["claude", "codex"].map((cli) => [
        "wsl.exe",
        "--distribution",
        "Ubuntu",
        "--cd",
        request.projectDir,
        "--exec",
        `${request.projectDir}/.omi/bin/omi`,
        "--omi-worker-version",
        cli,
      ]),
    );
  });
  it("fails the named worker check when only the user's shell can run that CLI", async () => {
    const base = probe({}, config);
    const doctor = createInstallationDoctor({
      ...base,
      command: (executable, args, cwd) =>
        args.includes("--omi-worker-version")
          ? Promise.resolve(undefined)
          : base.command(executable, args, cwd),
    });
    const report = await inspectInstallation(doctor, request);
    expect(report.supported).toBe(false);
    for (const cli of ["claude", "codex"]) {
      expect(report.checks.find((check) => check.name === `worker-cli-${cli}`)).toMatchObject({
        ok: false,
        fix: expect.stringContaining("omi install --apply") as unknown,
      });
    }
  });
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
      expect(["pass", "fail", "warn"]).toContain(check.status);
      expect(check.fix.length).toBeGreaterThan(0);
    }
  });

  it("reports a missing gh login without reaching later GitHub checks", async () => {
    const { report, status } = await run({ "gh api user": undefined });
    expect(report.supported).toBe(false);
    expect(status("github-auth")).toMatchObject({ ok: false, status: "fail" });
    expect(status("github-auth")?.fix).toContain("github.token");
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

describe("doctor local settings", () => {
  it("refuses a git-tracked local credential file", async () => {
    const base = probe({}, config);
    const doctor = createInstallationDoctor({
      ...base,
      settings: () =>
        Promise.resolve({
          version: 1,
          github: { token: "fake-github", gitUser: { name: "bot", email: "bot@example.com" } },
          profiles: [
            { id: "claude-main", tool: "claude", auth: { type: "token", token: "fake-claude" } },
          ],
        }),
      command: (executable, args, cwd) =>
        executable === "git"
          ? Promise.resolve(".omi/omisetting.local.json")
          : base.command(executable, args, cwd),
    });
    const report = await inspectInstallation(doctor, request);
    expect(report.checks.find((check) => check.name === "settings-untracked")).toMatchObject({
      ok: false,
    });
    expect(report.supported).toBe(false);
  });
});

it("reports missing or invalid settings without probing credentials", async () => {
  const base = probe({}, config);
  for (const settings of [
    () => Promise.resolve(undefined),
    () => Promise.reject(new Error("profiles[1].auth.token: invalid or missing value")),
  ]) {
    const report = await inspectInstallation(
      createInstallationDoctor({ ...base, settings }),
      request,
    );
    expect(report.supported).toBe(false);
    expect(report.checks.find((check) => check.name === "settings-schema")?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "github-auth")?.ok).toBe(false);
  }
});

it("fails a rejected Claude token using only that profile's env and a path diagnostic", async () => {
  const base = probe({}, config);
  const environments: Readonly<Record<string, string>>[] = [];
  const report = await inspectInstallation(
    createInstallationDoctor({
      ...base,
      settings: () =>
        Promise.resolve({
          version: 1,
          github: { token: "fake-github", gitUser: { name: "bot", email: "bot@example.com" } },
          profiles: [
            { id: "claude-one", tool: "claude", auth: { type: "token", token: "fake-claude-one" } },
            { id: "claude-two", tool: "claude", auth: { type: "token", token: "fake-claude-two" } },
          ],
        }),
      command: (executable, args, cwd, env) => {
        if (executable === "claude" && args[0] === "auth") {
          if (env !== undefined) environments.push(env);
          return Promise.resolve('{"loggedIn":false}');
        }
        return base.command(executable, args, cwd);
      },
    }),
    request,
  );
  expect(report.checks.find((check) => check.name === "profiles[1].auth.token")).toMatchObject({
    ok: false,
    detail: "profiles[1].auth.token: authentication failed",
  });
  expect(environments.map((env) => env["CLAUDE_CODE_OAUTH_TOKEN"])).toEqual([
    "fake-claude-one",
    "fake-claude-two",
  ]);
  expect(environments.every((env) => env["GH_TOKEN"] === undefined)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("fake-claude");
});

it("warns about missing rulesets without failing doctor", async () => {
  const { report, status } = await run();
  expect(status("github-rulesets")).toMatchObject({ status: "warn" });
  expect(status("github-rulesets")?.detail).toContain("missing");
  expect(report.supported).toBe(true);
});

it("warns for a weaker main approval while keeping doctor supported", async () => {
  const { desiredBranchRulesets } = await import("../../../src/domain/delivery/github-rulesets.js");
  const rulesets = desiredBranchRulesets(config.branches, ["ci"]).map((ruleset, index) => ({
    ...ruleset,
    id: index + 1,
  }));
  const main = rulesets[0];
  if (main === undefined) throw new Error("main fixture required");
  const weak = {
    ...main,
    rules: main.rules.map((rule) =>
      rule.type === "pull_request"
        ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 0 } }
        : rule,
    ),
  };
  const { report, status } = await run({
    "gh api repos/acme/app/rulesets?includes_parents=false&per_page=100": JSON.stringify(rulesets),
    "gh api repos/acme/app/rulesets/1": JSON.stringify(weak),
    "gh api repos/acme/app/rulesets/2": JSON.stringify(rulesets[1]),
  });
  expect(status("github-rulesets")).toMatchObject({
    status: "warn",
    detail: "effective rules on omi-main lack or weaken pull_request",
  });
  expect(report.supported).toBe(true);
});
it("warns for missing rulesets with readable GitHub access", async () => {
  const { report, status } = await run({
    "gh api repos/acme/app/rulesets?includes_parents=false&per_page=100": "[]",
  });
  expect(status("github-rulesets")).toMatchObject({
    status: "warn",
    detail: "ruleset omi-main missing; ruleset omi-develop missing",
  });
  expect(report.supported).toBe(true);
});
