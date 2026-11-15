import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type Context } from "../../../../tools/coordinator/flow.ts";
import type { Command } from "../../../../tools/coordinator/process-runner.ts";

const sections = [
  "Stop reason",
  "PO instructions for next session",
  "Queue",
  "Pending PO decisions not yet in an Issue",
  "Manual steps in progress",
];
const document = sections.map((s) => `## ${s}\n`).join("\n");
const sha = "a".repeat(40);
const dirs: string[] = [];
function setup(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "omi-handoff-"));
  dirs.push(dir);
  const file = join(dir, "handoff.md");
  writeFileSync(file, text);
  const seen: Command[] = [];
  const ctx: Context = {
    hostCwd: dir,
    isWindows: false,
    target: { viaWslExe: false, distro: "Ubuntu", repoDir: dir },
    run: (c) => {
      seen.push(c);
      const stdout =
        c.file === "git"
          ? sha
          : c.args.includes("user")
            ? "minibox-claude-code"
            : JSON.stringify({
                data: {
                  organization: { projectV2: { id: "PVT_1", readme: "old" } },
                  updateProjectV2: { projectV2: { id: "PVT_1" } },
                },
              });
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    },
  };
  return { file, ctx, seen };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("Project handoff", () => {
  it("replaces README with timestamp, develop SHA, Coordinator and validated sections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    try {
      const { file, ctx, seen } = setup(
        document.replace("## Stop reason\n", "## Stop reason\n- PO stopped the session\n"),
      );
      expect(await main(["handoff", "--file", file], ctx)).toBe(0);
      const mutation = seen.find((c) => c.input?.includes("mutation"));
      const payload = JSON.parse(mutation?.input ?? "{}") as {
        variables: { readme: string; id: string };
      };
      expect(payload.variables.id).toBe("PVT_1");
      expect(payload.variables.readme).toContain("2026-11-15T12:00:00.000Z");
      expect(payload.variables.readme).toContain(sha);
      expect(payload.variables.readme).toContain("minibox-claude-code");
      expect(payload.variables.readme).toContain("- PO stopped the session");
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    ["missing section", document.replace("## Stop reason\n", "")],
    ["unknown section", document + "\n## Unknown\n"],
    ["duplicate section", document + "\n## Stop reason\n"],
    ["16 bullets", document + "- item\n".repeat(16)],
    ["2001 characters", document + "x".repeat(2001 - document.length)],
    ["credential", document + "- password: example-secret-123456\n"],
    ["unbounded prose", document + "unstructured prose\n"],
  ])("refuses %s without writing", async (_name, text) => {
    const { file, ctx, seen } = setup(text);
    await expect(main(["handoff", "--file", file], ctx)).rejects.toThrow();
    expect(seen.some((c) => c.input?.includes("mutation"))).toBe(false);
  });
  it("accepts 15 bullet lines and 2000 characters", async () => {
    const base = document + "- item\n".repeat(14) + "- ";
    const { file, ctx } = setup(base + "x".repeat(2000 - base.length));
    expect(await main(["handoff", "--file", file], ctx)).toBe(0);
  });
  it("clears the README", async () => {
    const { ctx, seen } = setup(document);
    expect(await main(["handoff", "--clear"], ctx)).toBe(0);
    expect(seen.find((c) => c.input?.includes("mutation"))?.input).toContain('"readme":""');
  });
  it.each([{ args: ["--clear"] }, { args: ["--file"] }])(
    "dry-run does not write with $args",
    async ({ args }) => {
      const { file, ctx, seen } = setup(document);
      expect(
        await main(["handoff", ...args, ...(args[0] === "--file" ? [file] : []), "--dry-run"], ctx),
      ).toBe(0);
      expect(seen.some((c) => c.input?.includes("mutation"))).toBe(false);
    },
  );
  it.each([{ args: [] }, { args: ["--clear", "--file", "unused"] }])(
    "rejects ambiguous input $args",
    async ({ args }) => {
      const { ctx } = setup(document);
      await expect(main(["handoff", ...args], ctx)).rejects.toThrow();
    },
  );
});
