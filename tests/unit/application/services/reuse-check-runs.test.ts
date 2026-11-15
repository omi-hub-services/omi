import { describe, expect, it } from "vitest";
import type {
  ArtifactReference,
  ArtifactWrite,
} from "../../../../src/application/contracts/artifact.ts";
import type { CheckRunRecord } from "../../../../src/application/contracts/check-run.ts";
import type { CheckResultStore } from "../../../../src/application/ports/check-result-store.ts";
import type {
  CheckRunner,
  CheckRunRequest,
} from "../../../../src/application/ports/check-runner.ts";
import { reuseCheckRuns } from "../../../../src/application/services/reuse-check-runs.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const SHA256 = "c".repeat(64);

function memoryResults(): CheckResultStore {
  const rows: CheckRunRecord[] = [];
  return {
    find: (checkId, revision, command) =>
      rows
        .filter(
          (r) =>
            r.checkId === checkId &&
            r.revision === revision &&
            JSON.stringify(r.command) === JSON.stringify(command),
        )
        .at(-1),
    save: (record) => void rows.push(record),
  };
}

function rig(
  options: {
    statuses?: CheckRunRecord["status"][];
    command?: string[];
    /** Runs while the check "executes", e.g. a formatter rewriting a tracked file. */
    during?: (state: { head: string; dirty: boolean }) => void;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const writes: ArtifactWrite[] = [];
  const artifacts = {
    write(input: ArtifactWrite): ArtifactReference {
      files.set(input.path, input.bytes);
      writes.push(input);
      return { path: input.path, sha256: SHA256 };
    },
    read(reference: ArtifactReference): Uint8Array {
      const bytes = files.get(reference.path);
      if (bytes === undefined) throw new Error("NOT_FOUND");
      return bytes;
    },
  };
  const state = { head: HEAD, dirty: false };
  const statuses = [...(options.statuses ?? [])];
  let runs = 0;
  let command = options.command ?? ["npm", "run", "check"];
  const results = memoryResults();
  const inner: CheckRunner = {
    has: () => true,
    command: () => command,
    run(request: CheckRunRequest): Promise<CheckRunRecord> {
      runs += 1;
      options.during?.(state);
      const status = statuses.shift() ?? "passed";
      const evidence = artifacts.write({
        id: `ev-${String(runs)}`,
        path: `${request.artifactRoot}/checks/${request.checkId}.json`,
        bytes: new TextEncoder().encode(`{"log":"run ${String(runs)}"}`),
        classification: "check-evidence",
        createdAt: "2026-11-15T00:00:00.000Z",
      });
      return Promise.resolve({
        checkId: request.checkId,
        status,
        exitCode: status === "passed" ? 0 : 1,
        command,
        startedAt: "2026-11-15T00:00:00.000Z",
        endedAt: "2026-11-15T00:00:05.000Z",
        revision: state.head,
        evidence,
      });
    },
  };
  let ids = 0;
  const make = () =>
    reuseCheckRuns(inner, {
      artifacts,
      results,
      workspaces: {
        inspect: () => ({
          ok: true,
          value: {
            path: "/w",
            headSha: state.head,
            branch: "task/x",
            dirty: state.dirty,
            hasIgnoredFiles: false,
          },
        }),
      },
      now: () => Date.parse("2026-11-15T00:01:00.000Z"),
      nextId: () => `copy-${String((ids += 1))}`,
    });
  const request = (attempt: string): CheckRunRequest => ({
    attemptId: attempt,
    checkId: "project-check",
    workspacePath: "/w",
    artifactRoot: `attempts/${attempt}`,
  });
  const reusing = make();
  return {
    run: (attempt: string) => reusing.run(request(attempt)),
    /** A runner built after a restart: nothing in memory but the shared result store. */
    restarted: () => {
      const again = make();
      return (attempt: string) => again.run(request(attempt));
    },
    state,
    runs: () => runs,
    setCommand: (c: string[]) => (command = c),
    files,
    writes,
  };
}

describe("reuseCheckRuns", () => {
  it("runs a check once and gives the second attempt the stored result with its own evidence copy", async () => {
    const r = rig();
    const first = await r.run("a1");
    const second = await r.run("a2");
    expect(r.runs()).toBe(1);
    expect(second).toMatchObject({ status: "passed", revision: HEAD, exitCode: 0 });
    expect(second.evidence.path).toBe("attempts/a2/checks/project-check.json");
    expect(new TextDecoder().decode(r.files.get(second.evidence.path))).toBe(
      new TextDecoder().decode(r.files.get(first.evidence.path)),
    );
    expect(r.writes.at(-1)).toMatchObject({ producerAttemptId: "a2" });
  });

  it("reuses the persisted result after a restart (a new runner over the same store)", async () => {
    const r = rig();
    await r.run("a1");
    const afterRestart = r.restarted();
    expect((await afterRestart("a2")).status).toBe("passed");
    expect(r.runs()).toBe(1);
  });

  it("runs again for another head, another command or a dirty worktree", async () => {
    const r = rig();
    await r.run("a1");
    r.state.head = OTHER;
    await r.run("a2");
    expect(r.runs()).toBe(2);
    r.setCommand(["npm", "test"]);
    await r.run("a3");
    expect(r.runs()).toBe(3);
    r.state.dirty = true;
    await r.run("a4");
    await r.run("a5");
    expect(r.runs()).toBe(5);
  });

  it("never reuses a failed or timed-out result for a pass", async () => {
    const r = rig({ statuses: ["failed", "timed-out"] });
    expect((await r.run("a1")).status).toBe("failed");
    expect((await r.run("a2")).status).toBe("timed-out");
    expect((await r.run("a3")).status).toBe("passed");
    expect(r.runs()).toBe(3);
  });

  it("does not store a pass when the check rewrote a tracked file", async () => {
    const r = rig({
      during: (state) => {
        state.dirty = true;
      },
    });
    expect((await r.run("a1")).status).toBe("passed");
    r.state.dirty = false;
    await r.run("a2");
    expect(r.runs()).toBe(2);
  });

  it("does not store a pass when HEAD moved while the check ran", async () => {
    const r = rig({
      during: (state) => {
        state.head = OTHER;
      },
    });
    await r.run("a1");
    r.state.head = HEAD;
    await r.run("a2");
    expect(r.runs()).toBe(2);
  });

  it("does not reuse anything when the runner exposes no command", async () => {
    let runs = 0;
    const inner: CheckRunner = {
      has: () => true,
      run: (request) => {
        runs += 1;
        return Promise.resolve({
          checkId: request.checkId,
          status: "passed",
          exitCode: 0,
          command: ["x"],
          startedAt: "2026-11-15T00:00:00.000Z",
          endedAt: "2026-11-15T00:00:01.000Z",
          revision: HEAD,
          evidence: { path: "a/checks/x.json", sha256: SHA256 },
        });
      },
    };
    const reusing = reuseCheckRuns(inner, {
      artifacts: { write: () => ({ path: "p", sha256: SHA256 }), read: () => new Uint8Array() },
      results: memoryResults(),
      workspaces: {
        inspect: () => ({ ok: false, error: { code: "WORKSPACE_NOT_FOUND" } }) as never,
      },
      now: () => 0,
      nextId: () => "id",
    });
    const request = { attemptId: "a", checkId: "x", workspacePath: "/w", artifactRoot: "a" };
    await reusing.run(request);
    await reusing.run(request);
    expect(runs).toBe(2);
  });
});
