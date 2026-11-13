import { readFileSync, writeFileSync } from "node:fs";

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function validateRelease(metadata: unknown, changelog: string, tag?: string): string {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    !semver.test(metadata.version)
  )
    throw new Error("Invalid package version: expected SemVer");
  const version = metadata.version;
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag must equal v${version}`);
  const sections = changelog.replaceAll("\r\n", "\n").split(/^## /m).slice(1);
  const matches = sections.filter(
    (section) =>
      section.split("\n")[0]?.startsWith(`[${version}] - `) &&
      /^\[.*\] - \d{4}-\d{2}-\d{2}$/.test(section.split("\n")[0] ?? ""),
  );
  if (matches.length === 0) throw new Error(`Missing changelog entry for ${version}`);
  if (matches.length !== 1) throw new Error(`Duplicate changelog entry for ${version}`);
  const section = matches[0] ?? "";
  const notes = section.slice(section.indexOf("\n") + 1).trim();
  if (!/^### Breaking$/m.test(notes)) throw new Error(`Missing ### Breaking for ${version}`);
  return `${notes}\n`;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--tag")) {
      throw new Error("Usage: node tools/check-release.ts [--tag <tag>]");
    }
    const metadata: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    const notes = validateRelease(metadata, readFileSync("CHANGELOG.md", "utf8"), args[1]);
    if (args.length > 0) writeFileSync(".tmp/release-notes.md", notes);
    console.log("check-release: package version, changelog and optional tag valid");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
