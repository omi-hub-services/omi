import { join } from "node:path";

const START = "<!-- omi-squad:start -->";
const END = "<!-- omi-squad:end -->";

export function installationTarget(root: string, path: string): string {
  if (path.startsWith("bridge/skills/"))
    return join(root, ".claude/skills", path.slice("bridge/skills/".length));
  if (path.startsWith("bridge/skill/"))
    return join(root, ".claude/skills/omi-squad", path.slice("bridge/skill/".length));
  if (path === "bridge/CLAUDE.md" || path === "bridge/AGENTS.md")
    return join(root, path.slice("bridge/".length));
  return join(root, ".omi-squad", path);
}

export function isProjectInstruction(path: string): boolean {
  return path === "bridge/CLAUDE.md" || path === "bridge/AGENTS.md";
}

export function wrapProjectInstruction(text: string): string {
  return `${START}\n${text.trimEnd()}\n${END}`;
}

/** Only the marked span is framework-owned; ambiguous markers must never overwrite user text. */
export function projectInstructionBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (starts === 0 && ends === 0) return undefined;
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (starts !== 1 || ends !== 1 || start > end) throw new Error("INVALID_INSTRUCTION_MARKERS");
  return text.slice(start, end + END.length);
}

export function mergeProjectInstruction(
  text: string | undefined,
  block: string | undefined,
): string {
  const current = projectInstructionBlock(text);
  if (current !== undefined) return (text ?? "").replace(current, () => block ?? "");
  if (block === undefined) return text ?? "";
  return `${text ?? ""}${text === undefined || text.endsWith("\n") ? "" : "\n"}${block}\n`;
}
