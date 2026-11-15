import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Schema, slugSchema } from "../../../src/application/contracts/identifiers.ts";

// Guards templates/project/.omi-squad/provenance/skills.lock.json against the skill files, so a
// skill cannot change, appear or disappear without its provenance changing with it.

const squadDir = join(import.meta.dirname, "../../../templates/project/.omi-squad");
const NOTICE = "skills/NOTICE.md";

interface LockFile {
  path: string;
  sha256: string;
}
interface LockSkill {
  id: string;
  version: string;
  sha256: string;
  sources: { source: string; originalPaths: LockFile[] }[];
  files: LockFile[];
  modified: boolean;
  modification: string;
}
interface Lock {
  noticeFile: LockFile;
  sources: Record<
    string,
    {
      repository: string;
      commit: string;
      license: string;
      copyright: string;
      licenseSha256: string;
    }
  >;
  skills: LockSkill[];
  exclusions: { source: string; path: string; reason: string }[];
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Content with CRLF normalised to LF, as `schemas:check` does, so autocrlf checkouts still match. */
const readNormalised = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Returns one message per mismatch between the lock file and the files under `root`. */
function findLockViolations(root: string): string[] {
  const out: string[] = [];
  const lock = JSON.parse(readFileSync(join(root, "provenance/skills.lock.json"), "utf8")) as Lock;

  const notice = readNormalised(join(root, NOTICE));
  if (lock.noticeFile.path !== NOTICE || sha(notice) !== lock.noticeFile.sha256) {
    out.push(`${NOTICE}: sha256 does not match noticeFile`);
  }
  for (const [id, source] of Object.entries(lock.sources)) {
    if (!/^[0-9a-f]{40}$/.test(source.commit)) out.push(`source ${id}: commit is not a full sha`);
    if (source.license !== "MIT") out.push(`source ${id}: unexpected licence ${source.license}`);
    if (!sha256Schema.safeParse(source.licenseSha256).success) {
      out.push(`source ${id}: bad licenseSha256`);
    }
    if (!notice.includes(source.copyright)) out.push(`source ${id}: copyright not in NOTICE`);
    if (!notice.includes(source.commit)) out.push(`source ${id}: commit not in NOTICE`);
  }

  const listed = new Set<string>();
  const ids = new Set<string>();
  for (const skill of lock.skills) {
    if (ids.has(skill.id)) out.push(`${skill.id}: duplicate id`);
    ids.add(skill.id);
    if (!slugSchema.safeParse(skill.id).success) out.push(`${skill.id}: not a valid skill id`);
    if (skill.version.length === 0) out.push(`${skill.id}: empty version`);
    if (skill.sources.length === 0) out.push(`${skill.id}: no source recorded`);
    if (skill.modification.trim() === "") out.push(`${skill.id}: modification not described`);
    for (const { source, originalPaths } of skill.sources) {
      if (!(source in lock.sources)) out.push(`${skill.id}: unknown source ${source}`);
      if (originalPaths.length === 0) out.push(`${skill.id}: no original path for ${source}`);
      for (const original of originalPaths) {
        if (!sha256Schema.safeParse(original.sha256).success) {
          out.push(`${skill.id}: bad original sha256 for ${original.path}`);
        }
      }
    }
    if (!skill.files.some((f) => f.path === `skills/${skill.id}/SKILL.md`)) {
      out.push(`${skill.id}: SKILL.md missing from files`);
    }
    for (const file of skill.files) {
      listed.add(file.path);
      if (!file.path.startsWith(`skills/${skill.id}/`)) {
        out.push(`${file.path}: outside skills/${skill.id}/`);
      }
      let actual: string;
      try {
        actual = sha(readNormalised(join(root, file.path)));
      } catch {
        out.push(`${file.path}: listed in the lock but missing`);
        continue;
      }
      if (actual !== file.sha256) out.push(`${file.path}: sha256 does not match the lock`);
    }
    const aggregate = sha(skill.files.map((f) => `${f.path} ${f.sha256}\n`).join(""));
    if (aggregate !== skill.sha256) out.push(`${skill.id}: skill sha256 is not the file aggregate`);
    const skillText = readIfPresent(join(root, `skills/${skill.id}/SKILL.md`));
    if (skillText !== undefined) {
      const name = /^name:\s*(\S+)\s*$/m.exec(skillText);
      if (name?.[1] !== skill.id) out.push(`${skill.id}: frontmatter name differs from id`);
    }
  }

  for (const file of listFiles(join(root, "skills"))) {
    const rel = relative(root, file).split("\\").join("/");
    if (rel !== NOTICE && !listed.has(rel)) out.push(`${rel}: file has no provenance entry`);
  }
  return out;
}

describe("skills.lock.json", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function copyOfSquadDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "omi-skills-lock-"));
    tempRoots.push(dir);
    cpSync(squadDir, dir, { recursive: true });
    return dir;
  }

  it("matches every curated file, and every file has provenance", () => {
    expect(findLockViolations(squadDir)).toEqual([]);
  });

  it("records the exclusions with a reason", () => {
    const lock = JSON.parse(
      readFileSync(join(squadDir, "provenance/skills.lock.json"), "utf8"),
    ) as Lock;
    expect(lock.exclusions.length).toBeGreaterThan(0);
    for (const exclusion of lock.exclusions) {
      expect(exclusion.reason.trim()).not.toBe("");
      expect(exclusion.source in lock.sources).toBe(true);
    }
  });

  it("flags an edited skill file", () => {
    const dir = copyOfSquadDir();
    writeFileSync(join(dir, "skills/minimal-change/SKILL.md"), "tampered\n");
    expect(findLockViolations(dir)).toContain(
      "skills/minimal-change/SKILL.md: sha256 does not match the lock",
    );
  });

  it("flags a file with no lock entry", () => {
    const dir = copyOfSquadDir();
    writeFileSync(join(dir, "skills/minimal-change/extra.md"), "x\n");
    expect(findLockViolations(dir)).toContain(
      "skills/minimal-change/extra.md: file has no provenance entry",
    );
  });

  it("flags a skill that is in the lock but missing on disk", () => {
    const dir = copyOfSquadDir();
    rmSync(join(dir, "skills/independent-review"), { recursive: true });
    expect(findLockViolations(dir)).toContain(
      "skills/independent-review/SKILL.md: listed in the lock but missing",
    );
  });

  it("hashes CRLF content the same as LF", () => {
    const dir = copyOfSquadDir();
    for (const file of [NOTICE, "skills/minimal-change/SKILL.md"]) {
      const path = join(dir, file);
      writeFileSync(path, readNormalised(path).replaceAll("\n", "\r\n"));
    }
    expect(findLockViolations(dir)).toEqual([]);
  });

  it("flags an edited NOTICE", () => {
    const dir = copyOfSquadDir();
    writeFileSync(join(dir, NOTICE), "no notice\n");
    expect(findLockViolations(dir)).toContain(`${NOTICE}: sha256 does not match noticeFile`);
  });
});
