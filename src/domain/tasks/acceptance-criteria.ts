/** Only column-zero checkboxes immediately within the level-two AC section count. */
export function acceptanceCriteria(body: string): readonly string[] {
  const criteria: string[] = [];
  let active = false;
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
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
    if (!active) continue;
    const criterion = /^[-*+]\s+\[[ xX]\](.*)$/.exec(line)?.[1]?.trim();
    if (criterion !== undefined) criteria.push(criterion);
  }
  return criteria;
}
