import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SkillSource } from "../../application/ports/skill-source.js";
import { aggregateSkillHash, skillsLockSchema } from "./load-resolution-catalog.js";

/** Where `.omi-squad/` lives inside a worker's workspace, used to name bundled files. */
const WORKSPACE_SQUAD_DIR = ".omi-squad";

/**
 * Reads skills from an installed `.omi-squad` directory. The file list comes from the provenance
 * lock, but the hash is recomputed from the bytes read now, so an edited or missing file shows up
 * as a hash mismatch or an absent skill at dispatch instead of being trusted from the lock.
 */
export function createFileSkillSource(squadDir: string): SkillSource {
  return {
    read(id, version) {
      try {
        const lock = skillsLockSchema.parse(
          JSON.parse(readFileSync(join(squadDir, "provenance", "skills.lock.json"), "utf8")),
        );
        const skill = lock.skills.find((entry) => entry.id === id && entry.version === version);
        if (skill === undefined) return undefined;
        const files = skill.files.map((file) => {
          const bytes = readFileSync(join(squadDir, file.path));
          return {
            path: file.path,
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        });
        const main = files.find((file) => basename(file.path) === "SKILL.md");
        if (main === undefined) return undefined;
        return {
          sha256: aggregateSkillHash(files),
          skillMd: main.bytes.toString("utf8"),
          bundledFiles: files
            .filter((file) => file !== main)
            .map((file) => `${WORKSPACE_SQUAD_DIR}/${file.path}`),
        };
      } catch {
        return undefined;
      }
    },
  };
}
