/**
 * The Issue a pull request is for: `preparePr` writes exactly one `Issue: #N` line, and any other
 * Issue reference breaks the link. Undefined when no line, or two different Issues, are named.
 */
export function linkedIssueNumber(body: string): number | undefined {
  const linked = new Set(
    [...body.matchAll(/^Issue: #(\d+)\s*$/gm)].map((match) => Number(match[1])),
  );
  return linked.size === 1 ? [...linked][0] : undefined;
}
