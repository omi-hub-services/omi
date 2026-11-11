const CHECKBOX = /^([-*+]\s+\[)([ xX])\](.*)$/;

/**
 * Line indexes of the criteria in `lines` (each line without its terminator). Only column-zero
 * checkboxes immediately within the level-two AC section count: nested checkboxes, checkboxes in a
 * ``` or ~~~ fence and everything after the next heading (any level) do not.
 */
function criterionLineIndexes(lines: readonly string[]): number[] {
  const indexes: number[] = [];
  let active = false;
  let fence: { character: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (
        delimiter?.[1]?.[0] === fence.character &&
        delimiter[1].length >= fence.length &&
        delimiter[2]?.trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (delimiter?.[1] !== undefined) {
      fence = { character: delimiter[1][0] ?? "", length: delimiter[1].length };
      continue;
    }
    if (!active && /^##\s+Acceptance criteria\s*$/i.test(line)) {
      active = true;
      continue;
    }
    if (active && /^#{1,6}\s/.test(line)) break;
    if (active && CHECKBOX.test(line)) indexes.push(index);
  }
  return indexes;
}

/** Splits keeping each line's terminator, so a rejoin is byte-identical. */
function splitKeepingTerminators(body: string): string[] {
  return body.split(/(?<=\n)/);
}

const withoutTerminator = (line: string): string => line.replace(/\r?\n$/, "");

/** Only column-zero checkboxes immediately within the level-two AC section count. */
export function acceptanceCriteria(body: string): readonly string[] {
  const lines = body.split(/\r?\n/);
  return criterionLineIndexes(lines).map((index) =>
    (CHECKBOX.exec(lines[index] ?? "")?.[3] ?? "").trim(),
  );
}

export interface TickedCriteria {
  readonly body: string;
  /** Criteria counted by the same rule as `acceptanceCriteria`. */
  readonly total: number;
  /** Criteria that changed from `[ ]` to `[x]`. */
  readonly newly: number;
}

/**
 * Ticks every criterion checkbox. Only `[ ]` on a criterion line changes to `[x]`; every other
 * byte of the body, line endings included, stays as it was. Whether ticking is allowed is a
 * separate decision (`evaluateIssueClose`); this only performs the edit.
 */
export function tickAcceptanceCriteria(body: string): TickedCriteria {
  const lines = splitKeepingTerminators(body);
  const indexes = criterionLineIndexes(lines.map(withoutTerminator));
  let newly = 0;
  for (const index of indexes) {
    const line = lines[index] ?? "";
    if (/^[-*+]\s+\[ \]/.test(line)) {
      lines[index] = line.replace(/^([-*+]\s+\[) \]/, "$1x]");
      newly += 1;
    }
  }
  return { body: lines.join(""), total: indexes.length, newly };
}
