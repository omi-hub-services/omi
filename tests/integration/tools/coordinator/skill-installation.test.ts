import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("has a preview/apply/check installer for Coordinator-owned skills", async () => {
  const { existsSync } = await import("node:fs");
  expect(existsSync("tools/coordinator/skill-installation.ts")).toBe(true);
  const { installCoordinatorSkills } =
    await import("../../../../tools/coordinator/skill-installation.ts");
  const root = await mkdtemp(join(tmpdir(), "omi-skills-"));
  try {
    const source = join(root, "templates/bridges/repository/omi-next");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "canonical\n");
    expect(await installCoordinatorSkills(root, false)).toEqual(["omi-next"]);
    await installCoordinatorSkills(root, true);
    expect(await readFile(join(root, ".claude/skills/omi-next/SKILL.md"), "utf8")).toBe(
      "canonical\n",
    );
    expect(await installCoordinatorSkills(root, false)).toEqual([]);
    await writeFile(join(root, ".claude/skills/omi-next/SKILL.md"), "local drift\n");
    expect(await installCoordinatorSkills(root, false)).toEqual(["omi-next"]);
    expect(await readFile(join(root, ".claude/skills/omi-next/SKILL.md"), "utf8")).toBe(
      "local drift\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a listed copy whose parity evidence was removed", async () => {
  const { COPY_PARITY, checkCopyInventory } =
    await import("../../../../tools/coordinator/source-parity.ts");
  const root = await mkdtemp(join(tmpdir(), "omi-parity-"));
  try {
    const evidence = new Map<string, string[]>();
    for (const copy of COPY_PARITY) {
      for (const name of [copy.repo, copy.framework]) {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), "fixture\n");
      }
      evidence.set(copy.test, [...(evidence.get(copy.test) ?? []), copy.repo, copy.framework]);
    }
    for (const [name, paths] of evidence) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), paths.join("\n"));
    }
    await expect(checkCopyInventory(root)).resolves.toBeUndefined();
    await writeFile(join(root, COPY_PARITY[0].test), "parity removed\n");
    await expect(checkCopyInventory(root)).rejects.toThrow("PARITY_EVIDENCE_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
