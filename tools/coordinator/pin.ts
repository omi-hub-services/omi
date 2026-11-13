// Bootstrap/rescue entry point: intentionally imports no src/ or Coordinator settings.
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  assertSeparatePin,
  parsePinRecord,
  pinCheckoutPath,
  pinShaSchema,
  pinSourceSchema,
  pinInstallCommand,
  pinWorkRoot,
  refreshedRecord,
  refreshRefusal,
  type PinSource,
} from "./pin-policy.ts";
import { createProcessRunner, runChecked, type Runner } from "./process-runner.ts";

const commitSchema = z.object({
  sha: pinShaSchema,
  parents: z.array(z.object({ sha: pinShaSchema })),
});
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const gitFlags = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** Reads only GitHub-owned workflow/jobs evidence, never a similarly named third-party check. */
export async function verifyPin(
  run: Runner,
  repo: string,
  cwd: string,
  sha: string,
  source: PinSource,
): Promise<void> {
  const api = async (path: string): Promise<unknown> =>
    JSON.parse(
      await runChecked(run, { file: "gh", args: ["api", `repos/${repo}/${path}`], cwd }),
    ) as unknown;
  const candidate = commitSchema.parse(await api(`commits/${sha}`));
  let provenance = candidate.sha === sha;
  if (source === "develop") {
    provenance &&= candidate.parents.length >= 2;
    let cursor = commitSchema.parse(await api("commits/develop"));
    const seen = new Set<string>();
    for (let n = 0; cursor.sha !== sha && n < 200; n++) {
      const parent = cursor.parents[0]?.sha;
      if (parent === undefined || seen.has(parent)) break;
      seen.add(parent);
      cursor = commitSchema.parse(await api(`commits/${parent}`));
    }
    provenance &&= cursor.sha === sha;
  } else if (source === "main") {
    const compare = z
      .object({ merge_base_commit: z.object({ sha: pinShaSchema }) })
      .parse(await api(`compare/${sha}...main`));
    provenance &&= compare.merge_base_commit.sha === sha;
  } else {
    const tag = source.slice(4);
    const release = z
      .object({ tag_name: z.string(), draft: z.boolean() })
      .parse(await api(`releases/tags/${encodeURIComponent(tag)}`));
    const tagged = commitSchema.parse(await api(`commits/${encodeURIComponent(tag)}`));
    provenance &&= release.tag_name === tag && !release.draft && tagged.sha === sha;
  }
  if (!provenance) throw new Error("PIN_SOURCE_NOT_VERIFIED");
  const runs = z
    .object({
      total_count: z.number().int(),
      workflow_runs: z.array(
        z.object({
          id: z.number().int().positive(),
          run_attempt: z.number().int().positive(),
          head_sha: pinShaSchema,
          event: z.string(),
          head_branch: z.string().nullable(),
          head_repository: z.object({ full_name: z.string() }).nullable(),
        }),
      ),
    })
    .parse(await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`));
  if (runs.total_count > runs.workflow_runs.length) throw new Error("PIN_CI_HISTORY_TRUNCATED");
  const latest = runs.workflow_runs
    .filter(
      (r) =>
        r.head_sha === sha &&
        r.head_repository?.full_name === repo &&
        r.event === "push" &&
        ["main", "develop"].includes(r.head_branch ?? ""),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (latest === undefined) throw new Error("PIN_CHECK_NOT_GREEN");
  const jobs = z
    .object({
      total_count: z.number().int(),
      jobs: z.array(
        z.object({
          id: z.number().int(),
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
        }),
      ),
    })
    .parse(
      await api(
        `actions/runs/${String(latest.id)}/attempts/${String(latest.run_attempt)}/jobs?per_page=100`,
      ),
    );
  if (jobs.total_count > jobs.jobs.length) throw new Error("PIN_CI_JOBS_TRUNCATED");
  const refusal = refreshRefusal({ provenance, checks: jobs.jobs });
  if (refusal !== undefined) throw new Error(refusal);
}

interface PinInput {
  readonly action: "status" | "refresh" | "rollback";
  readonly repoRoot: string;
  readonly checkout?: string | undefined;
  readonly workRoot?: string | undefined;
  readonly to?: string | undefined;
  readonly source?: string | undefined;
  readonly dryRun?: boolean | undefined;
}
const exists = async (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );

export async function managePin(input: PinInput, run: Runner = createProcessRunner()) {
  const repoRoot = await realpath(resolve(input.repoRoot));
  const checkout = pinCheckoutPath(repoRoot, input.checkout);
  const parent = await realpath(dirname(checkout));
  const canonical = join(parent, checkout.slice(dirname(checkout).length + 1));
  assertSeparatePin(canonical, repoRoot);
  if (input.workRoot !== undefined) assertSeparatePin(canonical, await realpath(input.workRoot));
  if (await exists(checkout)) {
    if (
      (await lstat(checkout)).isSymbolicLink() ||
      relative(canonical, await realpath(checkout)) !== ""
    )
      throw new Error("PIN_CHECKOUT_SYMLINK");
  }
  const recordFile = join(repoRoot, "tools/coordinator/coordinator-pin.json");
  if ((await lstat(recordFile)).isSymbolicLink()) throw new Error("PIN_RECORD_SYMLINK");
  const original = await readFile(recordFile, "utf8");
  const record = parsePinRecord(JSON.parse(original) as unknown);
  const git = (cwd: string, args: string[]) =>
    runChecked(run, { file: "git", args: [...gitFlags, ...args], cwd });
  const installed = await exists(checkout);
  const installedSha = installed ? (await git(checkout, ["rev-parse", "HEAD"])).trim() : null;
  const dirty = installed
    ? (await git(checkout, ["status", "--porcelain", "--untracked-files=all"])).trim() !== ""
    : false;
  if (input.action === "status")
    return {
      record,
      checkout,
      installedSha,
      initialized: installedSha === record.sha && !dirty,
      dirty,
    };
  if (installed && (installedSha !== record.sha || dirty))
    throw new Error("PIN_CHECKOUT_DIRTY_OR_MISMATCHED");
  const rollback = input.action === "rollback";
  if (rollback && record.previous === null) throw new Error("PIN_NO_PREVIOUS_REVISION");
  const sha = pinShaSchema.parse(rollback ? record.previous?.sha : (input.to ?? record.sha));
  const source = pinSourceSchema.parse(
    rollback ? record.previous?.source : (input.source ?? record.source),
  );
  const repository = repositorySchema.parse(
    z.object({ nameWithOwner: z.string() }).parse(
      JSON.parse(
        await runChecked(run, {
          file: "gh",
          args: ["repo", "view", "--json", "nameWithOwner"],
          cwd: repoRoot,
        }),
      ) as unknown,
    ).nameWithOwner,
  );
  await verifyPin(run, repository, repoRoot, sha, source);
  const next = refreshedRecord(record, sha, source);
  if (!installed) next.previous = null;
  if (input.dryRun)
    return {
      dryRun: true,
      checkout,
      record: next,
      operations: [
        "clone detached SHA in fresh external staging checkout",
        "npm ci --ignore-scripts",
        "node tools/coordinator/flow.ts --help",
        "activate checkout and atomically save pin",
      ],
    };
  const lock = `${checkout}.lock`;
  await mkdir(lock);
  let stage: string | undefined;
  try {
    if ((await readFile(recordFile, "utf8")) !== original) throw new Error("PIN_RECORD_CHANGED");
    if (
      installed &&
      ((await git(checkout, ["rev-parse", "HEAD"])).trim() !== installedSha ||
        (await git(checkout, ["status", "--porcelain", "--untracked-files=all"])).trim() !== "")
    )
      throw new Error("PIN_CHECKOUT_CHANGED");
    if (!installed && (await exists(checkout))) throw new Error("PIN_CHECKOUT_CHANGED");
    stage = await mkdtemp(`${checkout}.stage-`);
    await git(repoRoot, [
      "clone",
      "--no-checkout",
      "--",
      `https://github.com/${repository}.git`,
      stage,
    ]);
    await git(stage, ["fetch", "origin", sha]);
    await git(stage, ["checkout", "--detach", sha]);
    if ((await git(stage, ["rev-parse", "HEAD"])).trim() !== sha)
      throw new Error("PIN_CLONE_SHA_MISMATCH");
    await runChecked(run, pinInstallCommand(process.platform, process.execPath, stage));
    for (const entry of ["flow.ts", "status.ts", "watch-web.ts", "pin.ts"]) {
      if (!(await lstat(join(stage, "tools/coordinator", entry))).isFile())
        throw new Error(
          "PIN_ENTRYPOINT_MISSING: first install requires a green merge containing the pin bootstrap",
        );
    }
    await runChecked(run, {
      file: process.execPath,
      args: ["tools/coordinator/flow.ts", "--help"],
      cwd: stage,
      timeoutMs: 30_000,
    });
    // The latest check may have changed while dependencies were installed.
    await verifyPin(run, repository, repoRoot, sha, source);
    if ((await readFile(recordFile, "utf8")) !== original) throw new Error("PIN_RECORD_CHANGED");
    const tempRoot = join(repoRoot, ".tmp");
    await mkdir(tempRoot, { recursive: true });
    if ((await lstat(tempRoot)).isSymbolicLink()) throw new Error("PIN_TEMP_SYMLINK");
    const tempRecord = join(tempRoot, `coordinator-pin-${randomUUID()}.json`);
    await writeFile(tempRecord, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    const backup = installed ? `${checkout}.previous-${record.sha}-${randomUUID()}` : undefined;
    if (backup !== undefined) await rename(checkout, backup);
    try {
      await rename(stage, checkout);
      try {
        await rename(tempRecord, recordFile);
      } catch (error) {
        await rename(checkout, stage);
        throw error;
      }
    } catch (error) {
      if (backup !== undefined) await rename(backup, checkout);
      throw error;
    } finally {
      await rm(tempRecord, { force: true });
    }
    stage = undefined;
    return { checkout, record: next, initialized: true };
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        to: { type: "string" },
        source: { type: "string" },
        repo: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const action = z.enum(["status", "refresh", "rollback"]).parse(positionals[0]);
    if (
      positionals.length !== 1 ||
      (action !== "refresh" && (values.to !== undefined || values.source !== undefined))
    )
      throw new Error(
        "usage: pin.ts status|refresh [--to <sha>] [--source main|develop|tag:<tag>]|rollback [--dry-run] [--repo <host-checkout>]",
      );
    const workRoot = pinWorkRoot(process.platform, process.env);
    const result = await managePin({
      action,
      repoRoot: values.repo ?? process.cwd(),
      checkout: process.env.OMI_COORDINATOR_PIN_DIR,
      workRoot,
      to: values.to,
      source: values.source,
      dryRun: values["dry-run"],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`pin: refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
