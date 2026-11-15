import { createRequire } from "node:module";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { assertSeparatePin } from "../../../../tools/coordinator/pin-policy.ts";
import { expect, it } from "vitest";

type Execute = (file: string, args: readonly string[]) => string;
type Bootstrap = (
  root: string,
  env: NodeJS.ProcessEnv,
  defaults: readonly string[],
  execute: Execute,
) => string;
const require = createRequire(import.meta.url);
function loadBootstrap(): Bootstrap {
  expect(existsSync("templates/prompts/coordinator-pin-guard.cjs")).toBe(true);
  return (
    require("../../../../templates/prompts/coordinator-pin-guard.cjs") as {
      runPinStatus: Bootstrap;
    }
  ).runPinStatus;
}

it.each(["host", "host-child", "ancestor", "host-alias", "wsl", "wsl-alias", "entry-alias"])(
  "never executes a rejected %s entry point",
  (kind) => {
    const run = loadBootstrap();
    const root = mkdtempSync(join(tmpdir(), "omi-pin-guard-"));
    try {
      const host = join(root, "host"),
        work = join(root, "work"),
        independent = join(root, "independent");
      for (const path of [host, work, independent]) mkdirSync(path);
      let selected =
        kind === "host" || kind === "host-alias"
          ? host
          : kind === "wsl" || kind === "wsl-alias"
            ? work
            : kind === "ancestor"
              ? root
              : kind === "host-child"
                ? join(host, "nested")
                : independent;
      const marker = join(root, "entry-executed");
      const entry = join(selected, "tools/coordinator/pin.ts");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(
        entry,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      );
      if (kind.endsWith("alias") && kind !== "entry-alias") {
        const alias = join(root, "alias");
        symlinkSync(selected, alias, "junction");
        selected = alias;
      }
      if (kind === "entry-alias") {
        const source = join(host, "pin.ts");
        writeFileSync(source, readFileSync(entry));
        rmSync(entry);
        symlinkSync(source, entry);
      }
      if (kind !== "entry-alias") {
        const canonical = realpathSync(selected);
        let policyRefused = false;
        try {
          assertSeparatePin(canonical, realpathSync(host));
          assertSeparatePin(canonical, realpathSync(work));
        } catch {
          policyRefused = true;
        }
        expect(policyRefused).toBe(true);
      }
      let calls = 0;
      const execute: Execute = (_file, args) => {
        calls++;
        runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
        return JSON.stringify({ initialized: true, checkout: selected });
      };
      expect(() =>
        run(
          host,
          { OMI_COORDINATOR_PIN_DIR: selected, OMI_WSL_REPO_DIR: work },
          ["pin", work, "Ubuntu"],
          execute,
        ),
      ).toThrow(/PIN_/);
      expect(calls).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("runs an isolated pin and refuses its attempt to redirect business commands into the worktree", () => {
  const run = loadBootstrap();
  const root = mkdtempSync(join(tmpdir(), "omi-pin-guard-"));
  try {
    const host = join(root, "host"),
      work = join(root, "work"),
      pin = join(root, "pin");
    for (const path of [host, work, join(pin, "tools/coordinator")])
      mkdirSync(path, { recursive: true });
    const marker = join(root, "executed");
    writeFileSync(
      join(pin, "tools/coordinator/pin.ts"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    let redirected = false;
    const execute: Execute = (_file, args) => {
      expect(args[1]).toBe("status");
      runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
      return JSON.stringify({ initialized: true, checkout: redirected ? host : pin });
    };
    expect(() => {
      assertSeparatePin(pin, host);
    }).not.toThrow();
    expect(() => {
      assertSeparatePin(pin, work);
    }).not.toThrow();
    const env = { OMI_COORDINATOR_PIN_DIR: pin, OMI_WSL_REPO_DIR: work };
    expect(run(host, env, ["pin", work, "Ubuntu"], execute)).toBe(pin);
    expect(existsSync(marker)).toBe(true);
    redirected = true;
    expect(() => run(host, env, ["pin", work, "Ubuntu"], execute)).toThrow("PIN_STATUS_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  "relative-pin",
  "relative-work",
  "empty-pin",
  "empty-work",
  "pin-dotdot-host",
  "pin-dotdot-work",
  "work-dotdot-pin",
  "unset-pin-alias",
  "unset-work-overlap",
])("does not execute an entry point for %s configuration", (kind) => {
  const run = loadBootstrap();
  const root = mkdtempSync(join(tmpdir(), "omi-pin-input-"));
  try {
    const host = join(root, "host"),
      work = join(root, "work"),
      pin = join(root, "pin");
    for (const dir of [host, work, pin]) mkdirSync(dir);
    const marker = join(root, "rejected-entry-executed");
    for (const directory of [host, work, pin]) {
      const entry = join(directory, "tools/coordinator/pin.ts");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(
        entry,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      );
    }
    const defaults = ["pin", work, "Ubuntu"];
    const env: NodeJS.ProcessEnv = { OMI_COORDINATOR_PIN_DIR: pin, OMI_WSL_REPO_DIR: work };
    switch (kind) {
      case "relative-pin":
        env.OMI_COORDINATOR_PIN_DIR = "../host";
        break;
      case "relative-work":
        env.OMI_WSL_REPO_DIR = "../pin";
        break;
      case "empty-pin":
        env.OMI_COORDINATOR_PIN_DIR = "";
        break;
      case "empty-work":
        env.OMI_WSL_REPO_DIR = "";
        break;
      case "pin-dotdot-host":
        env.OMI_COORDINATOR_PIN_DIR = `${pin}/../host`;
        break;
      case "pin-dotdot-work":
        env.OMI_COORDINATOR_PIN_DIR = `${pin}/../work`;
        break;
      case "work-dotdot-pin":
        env.OMI_WSL_REPO_DIR = `${work}/../pin`;
        break;
      case "unset-pin-alias":
        delete env.OMI_COORDINATOR_PIN_DIR;
        rmSync(pin, { recursive: true });
        symlinkSync(host, pin, "junction");
        break;
      case "unset-work-overlap":
        delete env.OMI_WSL_REPO_DIR;
        defaults[1] = pin;
        break;
    }
    let calls = 0;
    const execute: Execute = (_file, args) => {
      calls++;
      runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
      return JSON.stringify({
        initialized: true,
        checkout: dirname(dirname(dirname(args[0] ?? ""))),
      });
    };
    const refusal =
      kind === "relative-pin" || kind === "empty-pin"
        ? "PIN_PATH_MUST_BE_ABSOLUTE"
        : kind === "relative-work" || kind === "empty-work"
          ? "PIN_WORK_PATH_MUST_BE_ABSOLUTE"
          : "PIN_CHECKOUT_OVERLAPS_WORKTREE";
    expect(() => run(host, env, defaults, execute)).toThrow(refusal);
    expect(calls).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["unset-pin", "unset-work", "both-unset", "safe-dotdot"])(
  "uses safe canonical defaults with %s",
  (kind) => {
    const run = loadBootstrap();
    const root = mkdtempSync(join(tmpdir(), "omi-pin-defaults-"));
    try {
      const host = join(root, "host"),
        work = join(root, "work"),
        pin = join(root, "pin");
      for (const dir of [host, work, join(pin, "tools/coordinator")])
        mkdirSync(dir, { recursive: true });
      const marker = join(root, "executed");
      writeFileSync(
        join(pin, "tools/coordinator/pin.ts"),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      );
      const env: NodeJS.ProcessEnv = { OMI_COORDINATOR_PIN_DIR: pin, OMI_WSL_REPO_DIR: work };
      if (kind === "unset-pin" || kind === "both-unset") delete env.OMI_COORDINATOR_PIN_DIR;
      if (kind === "unset-work" || kind === "both-unset") delete env.OMI_WSL_REPO_DIR;
      if (kind === "safe-dotdot") env.OMI_COORDINATOR_PIN_DIR = `${work}/../pin`;
      let calls = 0;
      const execute: Execute = (_file, args) => {
        calls++;
        expect(args[0]).toBe(realpathSync(join(pin, "tools/coordinator/pin.ts")));
        runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
        return JSON.stringify({ initialized: true, checkout: realpathSync(pin) });
      };
      expect(run(host, env, ["pin", work, "Ubuntu"], execute)).toBe(realpathSync(pin));
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Execute the unmodified guard with real Node win32 path semantics and a controlled FS boundary.
// This runs on Linux too; it does not claim native Windows filesystem/PowerShell verification.
function loadWindowsBootstrap(): Bootstrap {
  const host = "C:\\Work\\Host";
  const roots = [
    host,
    "C:\\Work",
    `${host}\\Child`,
    "C:\\Work\\Pin",
    "C:\\Work\\Host-Pin",
    "D:\\Pin",
    "D:\\Tasks\\Work",
    "\\\\wsl.localhost\\Ubuntu\\home\\u\\work",
    "\\\\wsl.localhost\\Custom\\home\\u\\work",
  ];
  const normalize = (value: string) => win32.resolve("C:\\Work", value);
  const known = new Set(
    roots
      .flatMap((root) => [root, win32.join(root, "tools/coordinator/pin.ts")])
      .map((path) => normalize(path).toLowerCase()),
  );
  const aliases = new Map([
    ["c:\\links\\host", host],
    ["c:\\links\\wsl", "\\\\wsl.localhost\\Ubuntu\\home\\u\\work"],
  ]);
  const realpath = (value: string) => {
    const normalized = normalize(value);
    const alias = aliases.get(normalized.toLowerCase());
    if (alias !== undefined) return alias;
    if (!known.has(normalized.toLowerCase())) throw new Error(`ENOENT: ${value}`);
    // Preserve spelling to exercise case-insensitive comparison, rather than fixing it in the FS fake.
    return normalized;
  };
  const module = { exports: {} as unknown };
  const windowsRequire = (id: string): unknown => {
    if (id === "node:path") return win32;
    if (id === "node:fs") return { realpathSync: realpath };
    if (id === "node:child_process")
      return {
        execFileSync: () => {
          throw new Error("unexpected real execution");
        },
      };
    throw new Error(`Unexpected dependency before validation: ${id}`);
  };
  runInNewContext(readFileSync("templates/prompts/coordinator-pin-guard.cjs", "utf8"), {
    module,
    require: windowsRequire,
    process: { platform: "win32", execPath: "C:\\Node\\node.exe", argv: [] },
  });
  return (module.exports as { runPinStatus: Bootstrap }).runPinStatus;
}

const windowsRejected: readonly { label: string; env: NodeJS.ProcessEnv; error: string }[] = [
  {
    label: "relative pin",
    error: "PIN_PATH_MUST_BE_ABSOLUTE",
    env: { OMI_COORDINATOR_PIN_DIR: "..\\Host" },
  },
  {
    label: "drive-relative pin",
    error: "PIN_PATH_MUST_BE_ABSOLUTE",
    env: { OMI_COORDINATOR_PIN_DIR: "C:Host" },
  },
  { label: "empty pin", error: "PIN_PATH_MUST_BE_ABSOLUTE", env: { OMI_COORDINATOR_PIN_DIR: "" } },
  { label: "empty work", error: "PIN_WORK_PATH_MUST_BE_ABSOLUTE", env: { OMI_WSL_REPO_DIR: "" } },
  {
    label: "relative work",
    error: "PIN_WORK_PATH_MUST_BE_ABSOLUTE",
    env: { OMI_WSL_REPO_DIR: "..\\Pin" },
  },
  {
    label: "drive-relative work",
    error: "PIN_WORK_PATH_MUST_BE_ABSOLUTE",
    env: { OMI_WSL_REPO_DIR: "D:Tasks\\Work" },
  },
  {
    label: "host case and drive-letter spelling",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "c:\\wOrK\\hOsT" },
  },
  {
    label: "host child case",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "c:\\WORK\\HOST\\child" },
  },
  {
    label: "root-relative host",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "\\Work\\Host" },
  },
  {
    label: "ancestor case",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "c:\\WORK" },
  },
  {
    label: "dotdot into host",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "C:\\Work\\Pin\\..\\Host" },
  },
  {
    label: "forward-slash dotdot into host",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "C:/Work/Pin/../Host" },
  },
  {
    label: "host junction",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "c:\\LINKS\\host" },
  },
  {
    label: "WSL junction",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "C:\\Links\\Wsl" },
  },
  {
    label: "default WSL UNC case",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "\\\\WSL.LOCALHOST\\UBUNTU\\HOME\\U\\WORK" },
  },
  {
    label: "work on another drive with different letter case",
    error: "PIN_CHECKOUT_OVERLAPS_WORKTREE",
    env: { OMI_COORDINATOR_PIN_DIR: "d:\\tasks\\work", OMI_WSL_REPO_DIR: "D:\\Tasks\\Work" },
  },
  { label: "empty WSL distribution", error: "ENOENT", env: { OMI_WSL_DISTRO: "" } },
];
it.each(windowsRejected)(
  "Windows rejects $label before entry-point execution",
  ({ env, error }) => {
    const run = loadWindowsBootstrap();
    let calls = 0;
    const execute: Execute = (_file, args) => {
      calls++;
      return JSON.stringify({
        initialized: true,
        checkout: win32.dirname(win32.dirname(win32.dirname(args[0] ?? ""))),
      });
    };
    expect(() => run("C:\\Work\\Host", env, ["Pin", "/home/u/work", "Ubuntu"], execute)).toThrow(
      error,
    );
    expect(calls).toBe(0);
  },
);

const windowsAccepted: readonly { label: string; env: NodeJS.ProcessEnv; expected: string }[] = [
  { label: "all environment variables unset", env: {}, expected: "C:\\Work\\Pin" },
  {
    label: "custom WSL distribution with unset paths",
    env: { OMI_WSL_DISTRO: "Custom" },
    expected: "C:\\Work\\Pin",
  },
  {
    label: "isolated pin case spelling",
    env: { OMI_COORDINATOR_PIN_DIR: "c:\\WORK\\pIn" },
    expected: "c:\\WORK\\pIn",
  },
  {
    label: "separate drive",
    env: { OMI_COORDINATOR_PIN_DIR: "d:\\Pin", OMI_WSL_REPO_DIR: "D:\\Tasks\\Work" },
    expected: "d:\\Pin",
  },
  {
    label: "sibling sharing a prefix",
    env: { OMI_COORDINATOR_PIN_DIR: "C:\\Work\\Host-Pin" },
    expected: "C:\\Work\\Host-Pin",
  },
  {
    label: "safe dotdot",
    env: { OMI_COORDINATOR_PIN_DIR: "C:\\Work\\Host\\..\\Pin" },
    expected: "C:\\Work\\Pin",
  },
];
it.each(windowsAccepted)("Windows safely accepts $label", ({ env, expected }) => {
  const run = loadWindowsBootstrap();
  let calls = 0;
  const execute: Execute = (_file, args) => {
    calls++;
    expect(args).toEqual([win32.join(expected, "tools/coordinator/pin.ts"), "status"]);
    return JSON.stringify({ initialized: true, checkout: expected });
  };
  expect(run("C:\\Work\\Host", env, ["Pin", "/home/u/work", "Ubuntu"], execute)).toBe(expected);
  expect(calls).toBe(1);
});

it.runIf(process.platform === "win32")(
  "native Windows filesystem rejects case/drive-letter aliases before entry execution",
  () => {
    const run = loadBootstrap();
    const root = mkdtempSync(join(tmpdir(), "omi-pin-native-windows-"));
    try {
      const host = join(root, "Host"),
        work = join(root, "Work"),
        pin = join(root, "Pin");
      const marker = join(root, "executed");
      for (const directory of [host, work, pin]) {
        const entry = join(directory, "tools/coordinator/pin.ts");
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(
          entry,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
        );
      }
      let calls = 0;
      const execute: Execute = (_file, args) => {
        calls++;
        runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
        return JSON.stringify({
          initialized: true,
          checkout: dirname(dirname(dirname(args[0] ?? ""))),
        });
      };
      for (const candidate of [
        host.toLowerCase(),
        host.toUpperCase(),
        work.toLowerCase(),
        work.toUpperCase(),
        `${pin}\\..\\Host`,
      ]) {
        expect(() =>
          run(
            host,
            { OMI_COORDINATOR_PIN_DIR: candidate, OMI_WSL_REPO_DIR: work },
            ["Pin", work, "Ubuntu"],
            execute,
          ),
        ).toThrow();
        expect(calls).toBe(0);
        expect(existsSync(marker)).toBe(false);
      }
      expect(
        run(
          host,
          { OMI_COORDINATOR_PIN_DIR: pin, OMI_WSL_REPO_DIR: work },
          ["Pin", work, "Ubuntu"],
          execute,
        ),
      ).toBe(realpathSync(pin));
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
