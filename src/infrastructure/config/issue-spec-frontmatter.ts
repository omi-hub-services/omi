import { parse } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export type SpecSplit =
  | { readonly kind: "ok"; readonly frontmatter: unknown; readonly body: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** Splits a spec into parsed front matter and body. The one parser for runtime and Coordinator. */
export function splitIssueSpec(text: string): SpecSplit {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { kind: "invalid", reason: "spec requires YAML frontmatter" };
  try {
    return {
      kind: "ok",
      frontmatter: parse(match[1] ?? "", { uniqueKeys: true }),
      body: match[2] ?? "",
    };
  } catch (error) {
    // +1: front matter line 1 is file line 2, after the opening `---`. The YAML text is never echoed.
    const line = (error as { linePos?: readonly { line: number }[] }).linePos?.[0]?.line;
    const where = line === undefined ? "" : ` (line ${String(line + 1)})`;
    return { kind: "invalid", reason: `spec front matter is not valid YAML${where}` };
  }
}
