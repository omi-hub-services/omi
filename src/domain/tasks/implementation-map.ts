/** Relative POSIX path: no absolute path, no `..` segment, no drive prefix, no `\` or line break. */
export const RELATIVE_PATH_PATTERN =
  /^(?!\/)(?![A-Za-z]:)(?![\s\S]*(?:^|\/)\.\.(?:\/|$))[^\\\r\n\u2028\u2029]+$/u;

function isRelativePath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= 512 &&
    RELATIVE_PATH_PATTERN.test(path) &&
    !path.includes(String.fromCharCode(0))
  );
}

/**
 * The one authoritative `## Implementation map` parser, shared by intake, the readiness gate and
 * dispatch. Pure Markdown parsing: only that section contributes scope.
 */
export function implementationPaths(body: string): readonly string[] {
  const paths: string[] = [];
  let active = false;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter !== undefined) {
      if (fence === undefined) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (/^##[ \t]+Implementation map[ \t]*$/i.test(line)) {
      active = true;
      continue;
    }
    if (/^#{1,2}[ \t]+/.test(line)) {
      active = false;
      continue;
    }
    if (!active) continue;
    const marked = [...line.matchAll(/`([^`]+)`|\[[^\]]+\]\(([^)]+)\)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
    const candidates =
      marked.length > 0 ? marked : line.replace(/^\s*[-*+]\s+/, "").split(/[\s,;]+/);
    for (const path of candidates) {
      if (
        isRelativePath(path) &&
        !/[{}<>*?:]/.test(path) &&
        (path.includes("/") || /\.[a-z0-9]+$/i.test(path))
      )
        paths.push(path);
    }
  }
  return [...new Set(paths)];
}
