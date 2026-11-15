import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const roots: string[] = [];
afterEach(async () => {
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
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "omi-pin-"));
  roots.push(root);
  const repoRoot = join(root, "repo"),
    checkout = join(root, "omi-coordinator-pin");
  await mkdir(join(repoRoot, "tools/coordinator"), { recursive: true });
  const file = join(repoRoot, "tools/coordinator/coordinator-pin.json");
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, sha: A, source: "develop", previous: null }),
  );
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
  return { root, repoRoot, checkout, file, commands, run, manage: module.managePin, heads };
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
