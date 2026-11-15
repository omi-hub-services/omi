import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rename,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm), rename: vi.fn(original.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rm).mockReset();
  vi.mocked(rename).mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const A = "a".repeat(40),
  B = "b".repeat(40),
  P = "c".repeat(40);
async function rig(
  options: {
    green?: boolean;
    failInstall?: boolean;
    smokeFailure?: boolean;
    foreign?: boolean;
    sourceMismatch?: boolean;
    record?: "local" | "legacy" | "none";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "omi-pin-"));
  roots.push(root);
  const repoRoot = join(root, "repo"),
    checkout = join(root, "omi-coordinator-pin");
  await mkdir(join(repoRoot, "tools/coordinator"), { recursive: true });
  const file = join(repoRoot, ".omi/local/coordinator-pin.json");
  const legacy = join(repoRoot, "tools/coordinator/coordinator-pin.json");
  const seed = JSON.stringify({ schemaVersion: 1, sha: A, source: "develop", previous: null });
  if ((options.record ?? "local") === "local") {
    await mkdir(join(repoRoot, ".omi/local"), { recursive: true });
    await writeFile(file, seed);
  } else if (options.record === "legacy") await writeFile(legacy, seed);
  const commands: Command[] = [];
  const heads = new Map<string, string>();
  const run: Runner = async (c) => {
    commands.push(c);
    const result = (value: unknown) => ({
      code: 0,
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stderr: "",
    });
    if (c.file === "gh") {
      if (c.args[0] === "repo") return result({ nameWithOwner: "omi-hub-services/omi" });
      const path = c.args[1] ?? "";
      if (path.includes("workflows/ci.yml"))
        return result({
          total_count: 1,
          workflow_runs: [
            {
              id: 10,
              run_attempt: 2,
              head_sha: path.includes(B) ? B : A,
              head_branch: "develop",
              head_repository: {
                full_name: options.foreign ? "foreign/repo" : "omi-hub-services/omi",
              },
              event: "push",
            },
          ],
        });
      if (path.includes("/jobs"))
        return result({
          total_count: 1,
          jobs: [
            {
              id: 12,
              name: "check",
              status: "completed",
              conclusion: options.green === false ? "failure" : "success",
            },
          ],
        });
      const sha = path.endsWith("/develop")
        ? options.sourceMismatch
          ? P
          : B
        : (path.split("/").at(-1) ?? "");
      return result({
        sha,
        parents: sha === B ? [{ sha: A }, { sha: P }] : sha === A ? [{ sha: P }, { sha: P }] : [],
      });
    }
    if (c.file === "git") {
      if (c.args.includes("clone")) {
        const stage = c.args.at(-1) ?? "";
        await mkdir(join(stage, "tools/coordinator"), { recursive: true });
        for (const name of ["flow.ts", "status.ts", "watch-web.ts", "pin.ts"])
          await writeFile(join(stage, "tools/coordinator", name), "fixture\n");
      }
      if (c.args.includes("checkout")) heads.set(c.cwd ?? "", c.args.at(-1) ?? "");
      if (c.args.includes("rev-parse")) return result(heads.get(c.cwd ?? "") ?? A);
      return result("");
    }
    if (options.failInstall && c.args.includes("ci"))
      return { code: 1, stdout: "", stderr: "install failed" };
    if (options.smokeFailure && c.args.includes("--help"))
      return { code: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND" };
    return result("");
  };
  const module = await import("../../../../tools/coordinator/pin.ts");
  return { root, repoRoot, checkout, file, legacy, commands, run, manage: module.managePin, heads };
}

it("previews a verified external pin without creating a checkout, lock or record change", async () => {
  expect(existsSync("tools/coordinator/pin.ts")).toBe(true);
  const r = await rig();
  const before = await readFile(r.file, "utf8");
  await r.manage(
    { action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B, dryRun: true },
    r.run,
  );
  expect(await readdir(r.root)).toEqual(["repo"]);
  expect(await readFile(r.file, "utf8")).toBe(before);
  expect(r.commands.every((c) => c.file === "gh")).toBe(true);
});
it("checks out the exact SHA, installs without scripts and smokes plain Node before activating", async () => {
  const r = await rig();
  await r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run);
  expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({ sha: B, previous: null });
  const clone = r.commands.find((c) => c.args.includes("clone"));
  expect(clone?.args.at(-1)).not.toBe(r.repoRoot);
  expect(r.commands.find((c) => c.args.includes("ci"))?.args).toEqual(["ci", "--ignore-scripts"]);
  expect(r.commands.find((c) => c.args.includes("--help"))?.args).toEqual([
    "tools/coordinator/flow.ts",
    "--help",
  ]);
  expect(existsSync(join(r.checkout, "tools/coordinator/flow.ts"))).toBe(true);
});
it.each([
  { green: false },
  { foreign: true },
  { sourceMismatch: true },
  { failInstall: true },
  { smokeFailure: true },
])("preserves the installed checkout and record when refresh is refused: %j", async (options) => {
  const r = await rig(options);
  await mkdir(r.checkout);
  await writeFile(join(r.checkout, "keep"), "old");
  const before = await readFile(r.file, "utf8");
  await expect(
    r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run),
  ).rejects.toThrow();
  expect(await readFile(r.file, "utf8")).toBe(before);
  expect(await readFile(join(r.checkout, "keep"), "utf8")).toBe("old");
  expect((await readdir(r.root)).some((p) => p.includes(".stage-") || p.endsWith(".lock"))).toBe(
    false,
  );
});
it("rolls back to the prior SHA and retains the replaced pin for the next rollback", async () => {
  const r = await rig();
  await mkdir(r.checkout);
  await writeFile(
    r.file,
    JSON.stringify({
      schemaVersion: 1,
      sha: B,
      source: "develop",
      previous: { sha: A, source: "develop" },
    }),
  );
  r.heads.set(r.checkout, B);
  await r.manage({ action: "rollback", repoRoot: r.repoRoot, checkout: r.checkout }, r.run);
  expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({
    sha: A,
    previous: { sha: B, source: "develop" },
  });
});
it("reports first-install status without network or fallback execution", async () => {
  const r = await rig();
  expect(
    await r.manage({ action: "status", repoRoot: r.repoRoot, checkout: r.checkout }, r.run),
  ).toMatchObject({ initialized: false, installedSha: null });
  expect(r.commands).toEqual([]);
});
it.each(["refresh", "rollback"] as const)(
  "removes the previous checkout after a successful %s",
  async (action) => {
    const r = await rig();
    await mkdir(r.checkout);
    await writeFile(join(r.checkout, "keep"), "old");
    if (action === "rollback") {
      await writeFile(
        r.file,
        JSON.stringify({
          schemaVersion: 1,
          sha: B,
          source: "develop",
          previous: { sha: A, source: "develop" },
        }),
      );
      r.heads.set(r.checkout, B);
    }
    const result = await r.manage(
      { action, repoRoot: r.repoRoot, checkout: r.checkout, to: B },
      r.run,
    );
    expect(result).toMatchObject({ initialized: true });
    expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({
      sha: action === "refresh" ? B : A,
    });
    expect((await readdir(r.root)).filter((name) => name.includes(".previous-"))).toEqual([]);
  },
);
it.each(["checkout", "record"] as const)(
  "restores the previous checkout when the %s rename fails",
  async (failure) => {
    const r = await rig();
    await mkdir(r.checkout);
    await writeFile(join(r.checkout, "keep"), "old");
    const before = await readFile(r.file, "utf8");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (
        (failure === "checkout" && String(from).includes(".stage-")) ||
        (failure === "record" && to === r.file)
      )
        throw new Error("swap failed");
      await original.rename(from, to);
    });
    await expect(
      r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run),
    ).rejects.toThrow("swap failed");
    expect(await readFile(r.file, "utf8")).toBe(before);
    expect(await readFile(join(r.checkout, "keep"), "utf8")).toBe("old");
    expect(await readdir(r.root)).toEqual(["omi-coordinator-pin", "repo"]);
  },
);
it("warns and reports success when removing the backup fails", async () => {
  const r = await rig();
  await mkdir(r.checkout);
  await writeFile(join(r.checkout, "keep"), "old");
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (String(path).includes(".previous-")) {
      expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({ sha: B });
      throw new Error("backup removal denied");
    }
    await original.rm(path, options);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run),
  ).resolves.toMatchObject({ initialized: true });
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("backup removal denied"));
  expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({ sha: B });
  expect(existsSync(join(r.checkout, "tools/coordinator/flow.ts"))).toBe(true);
  expect((await readdir(r.root)).some((name) => name.includes(".previous-"))).toBe(true);
  expect((await readdir(r.root)).some((name) => name.endsWith(".lock"))).toBe(false);
});
it("refuses overlapping checkouts and symlink aliases", async () => {
  const r = await rig();
  await expect(
    r.manage(
      { action: "refresh", repoRoot: r.repoRoot, checkout: join(r.repoRoot, "pin"), dryRun: true },
      r.run,
    ),
  ).rejects.toThrow("OVERLAPS");
  const alias = join(r.root, "alias");
  await symlink(r.repoRoot, alias);
  await expect(
    r.manage(
      { action: "refresh", repoRoot: r.repoRoot, checkout: join(alias, "pin"), dryRun: true },
      r.run,
    ),
  ).rejects.toThrow("OVERLAPS");
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
it.each(["refresh", "rollback"] as const)(
  "%s leaves the tracked host checkout clean, writing only the local record",
  async (action) => {
    const r = await rig({ record: "legacy" });
    await writeFile(join(r.repoRoot, ".gitignore"), ".omi/local/\n.tmp/\n");
    git(r.repoRoot, "init", "-q");
    git(r.repoRoot, "add", "-A");
    git(r.repoRoot, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
    await mkdir(r.checkout);
    r.heads.set(r.checkout, A);
    await r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run);
    if (action === "rollback") {
      r.heads.set(r.checkout, B);
      await r.manage({ action, repoRoot: r.repoRoot, checkout: r.checkout }, r.run);
    }
    expect(git(r.repoRoot, "status", "--porcelain")).toBe("");
    expect(JSON.parse(await readFile(r.file, "utf8"))).toMatchObject({
      sha: action === "refresh" ? B : A,
    });
  },
);
it("migrates a legacy tracked record once without writing the legacy file", async () => {
  const r = await rig({ record: "legacy" });
  const before = await readFile(r.legacy, "utf8");
  const status = await r.manage(
    { action: "status", repoRoot: r.repoRoot, checkout: r.checkout },
    r.run,
  );
  expect(status).toMatchObject({ record: { sha: A, source: "develop" }, initialized: false });
  expect(await readFile(r.file, "utf8")).toBe(before);
  await writeFile(r.legacy, "changed");
  expect(
    await r.manage({ action: "status", repoRoot: r.repoRoot, checkout: r.checkout }, r.run),
  ).toMatchObject({ record: { sha: A } });
  expect(await readFile(r.legacy, "utf8")).toBe("changed");
});
it("refuses a malformed legacy record without creating a local record", async () => {
  const r = await rig({ record: "legacy" });
  await writeFile(r.legacy, "{}");
  await expect(
    r.manage({ action: "status", repoRoot: r.repoRoot, checkout: r.checkout }, r.run),
  ).rejects.toThrow();
  expect(existsSync(r.file)).toBe(false);
});
it("reports not initialized with a first-install hint when no record exists", async () => {
  const r = await rig({ record: "none" });
  const status = await r.manage(
    { action: "status", repoRoot: r.repoRoot, checkout: r.checkout },
    r.run,
  );
  expect(status).toMatchObject({ initialized: false, record: null });
  expect(JSON.stringify(status)).toContain("pin.ts refresh --to <sha> --source <source>");
  expect(r.commands).toEqual([]);
});
it("first install with --to and --source creates the local record with previous null", async () => {
  const r = await rig({ record: "none" });
  await r.manage(
    { action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B, source: "develop" },
    r.run,
  );
  expect(JSON.parse(await readFile(r.file, "utf8"))).toEqual({
    schemaVersion: 1,
    sha: B,
    source: "develop",
    previous: null,
  });
});
it("refuses refresh without a record unless --to and --source are given, and refuses rollback", async () => {
  const r = await rig({ record: "none" });
  await expect(
    r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run),
  ).rejects.toThrow("PIN_NOT_INITIALIZED");
  await expect(
    r.manage({ action: "rollback", repoRoot: r.repoRoot, checkout: r.checkout }, r.run),
  ).rejects.toThrow("PIN_NOT_INITIALIZED");
  expect(existsSync(r.file)).toBe(false);
});
it("refuses a symlinked local record or .omi directory", async () => {
  const r = await rig();
  await rm(r.file);
  await writeFile(join(r.root, "elsewhere.json"), "{}");
  await symlink(join(r.root, "elsewhere.json"), r.file);
  await expect(
    r.manage({ action: "status", repoRoot: r.repoRoot, checkout: r.checkout }, r.run),
  ).rejects.toThrow("PIN_RECORD_SYMLINK");
  const s = await rig({ record: "none" });
  await mkdir(join(s.root, "elsewhere"));
  await symlink(join(s.root, "elsewhere"), join(s.repoRoot, ".omi"));
  await expect(
    s.manage(
      { action: "refresh", repoRoot: s.repoRoot, checkout: s.checkout, to: B, source: "develop" },
      s.run,
    ),
  ).rejects.toThrow("PIN_RECORD_SYMLINK");
  expect(await readdir(join(s.root, "elsewhere"))).toEqual([]);
});
it("refuses activation when the local record changes during refresh", async () => {
  const r = await rig();
  const run: Runner = async (c) => {
    if (c.args.includes("--help")) await writeFile(r.file, JSON.stringify({ changed: true }));
    return r.run(c);
  };
  await expect(
    r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, run),
  ).rejects.toThrow("PIN_RECORD_CHANGED");
});
it("refuses overlapping pin mutations through the lock", async () => {
  const r = await rig();
  await mkdir(`${r.checkout}.lock`);
  await expect(
    r.manage({ action: "refresh", repoRoot: r.repoRoot, checkout: r.checkout, to: B }, r.run),
  ).rejects.toThrow();
});
