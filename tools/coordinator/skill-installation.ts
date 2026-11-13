// Coordinator-only native skill installation; never installs runtime state into framework source.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { wslTarget } from "./coordinator-target.ts";
import { PIN_DIRECTORY_NAME } from "./pin-policy.ts";
import { join, resolve } from "node:path";
import "../register-ts-imports.ts";
const { assertPlainParents, readOptional } =
  await import("../../src/infrastructure/config/package-content.ts");

/** Returns drift without writing unless apply is explicit. Source templates own every byte. */
export async function installCoordinatorSkills(root: string, apply: boolean): Promise<string[]> {
  const source = join(root, "templates/bridges/repository");
  const changes: string[] = [];
  for (const name of (await readdir(source)).sort()) {
    if (!/^omi-[a-z-]+$/.test(name)) throw new Error("INVALID_COORDINATOR_SKILL");
    const template = join(source, name, "SKILL.md");
    const target = join(root, ".claude/skills", name, "SKILL.md");
    await assertPlainParents(root, template);
    await assertPlainParents(root, target);
    let content = await readFile(template, "utf8");
    if (content.includes("{{pin_bootstrap}}")) {
      const bootstrap = join(root, "templates/prompts/coordinator-pin-bootstrap.md");
      await assertPlainParents(root, bootstrap);
      const text = await readFile(bootstrap, "utf8");
      const guard = join(root, "templates/prompts/coordinator-pin-guard.cjs");
      if (text.includes("{{pin_guard}}")) await assertPlainParents(root, guard);
      const defaults = wslTarget("linux", {});
      content = content.replaceAll(
        "{{pin_bootstrap}}",
        text
          .trimEnd()
          .replaceAll("{{pin_directory_name}}", PIN_DIRECTORY_NAME)
          .replaceAll("{{pin_default_wsl_repo}}", defaults.repoDir)
          .replaceAll("{{pin_default_wsl_distro}}", defaults.distro)
          .replaceAll(
            "{{pin_guard}}",
            text.includes("{{pin_guard}}") ? (await readFile(guard, "utf8")).trimEnd() : "",
          ),
      );
    }
    if ((await readOptional(target)) === content) continue;
    changes.push(name);
    if (apply) {
      await mkdir(join(root, ".claude/skills", name), { recursive: true });
      const temporary = `${target}.install`;
      await assertPlainParents(root, temporary);
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, target);
    }
  }
  return changes;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args[0] !== "install" ||
    args.slice(1).some((arg) => !["--apply", "--check"].includes(arg)) ||
    (args.includes("--apply") && args.includes("--check"))
  ) {
    throw new Error(
      "usage: node tools/coordinator/skill-installation.ts install [--apply | --check]",
    );
  }
  const changes = await installCoordinatorSkills(resolve("."), args.includes("--apply"));
  console.log(
    changes.length
      ? `Coordinator skills: ${changes.join(", ")}`
      : "Coordinator skills match templates",
  );
  if (args.includes("--check") && changes.length) process.exitCode = 1;
}
