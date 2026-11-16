import { readFile, writeFile } from "node:fs/promises";
import type { IssueSpecFile } from "../../application/ports/issue-spec-file.js";
import { splitIssueSpec } from "./issue-spec-frontmatter.js";

const MAX_SPEC_BYTES = 1024 * 1024;

/** One spec file chosen by the operator. Messages are fixed text: the file is never echoed. */
export function createIssueSpecFile(path: string): IssueSpecFile {
  async function source(): Promise<string | undefined> {
    try {
      const text = await readFile(path, "utf8");
      return Buffer.byteLength(text) > MAX_SPEC_BYTES ? undefined : text;
    } catch {
      return undefined;
    }
  }
  return {
    async read() {
      const text = await source();
      if (text === undefined) return { kind: "invalid", reason: "spec file cannot be read" };
      return splitIssueSpec(text);
    },
    async recordPlanKeyMarker(marker) {
      const text = await source();
      if (text === undefined) throw new Error("spec file cannot be read");
      await writeFile(path, `${text.trimEnd()}\n\n${marker}\n`);
    },
  };
}
