const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Compare numeric components without rounding large version numbers. */
function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left);
  const b = versionPattern.exec(right);
  if (a === null || b === null) throw new Error("INVALID_FRAMEWORK_VERSION");
  for (const index of [1, 2, 3]) {
    const x = BigInt(a[index] ?? "0");
    const y = BigInt(b[index] ?? "0");
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  const x = a[4].split(".");
  const y = b[4].split(".");
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const first = x[index];
    const second = y[index];
    if (first === second) continue;
    if (first === undefined) return -1;
    if (second === undefined) return 1;
    const numericFirst = /^\d+$/.test(first);
    const numericSecond = /^\d+$/.test(second);
    if (numericFirst && numericSecond) return BigInt(first) > BigInt(second) ? 1 : -1;
    if (numericFirst !== numericSecond) return numericFirst ? -1 : 1;
    return first > second ? 1 : -1;
  }
  return 0;
}

export function releaseUpdateNotes(changelog: string, installed: string, target: string) {
  if (compareVersions(target, installed) <= 0) throw new Error("VERSION_NOT_NEWER");
  const selected: string[] = [];
  const seen = new Set<string>();
  let breaking = false;
  for (const section of changelog.replaceAll("\r\n", "\n").split(/^## /m).slice(1)) {
    const heading = /^\[([^\]]+)\] - \d{4}-\d{2}-\d{2}\n/.exec(section);
    const version = heading?.[1];
    if (version === undefined || !versionPattern.test(version))
      throw new Error("INVALID_RELEASE_CHANGELOG");
    if (seen.has(version)) throw new Error("INVALID_RELEASE_CHANGELOG");
    seen.add(version);
    if (compareVersions(version, installed) <= 0 || compareVersions(version, target) > 0) continue;
    const breaks = section
      .split(/^### /m)
      .slice(1)
      .filter((part) => /^Breaking(?:\n|$)/.test(part));
    if (breaks.length !== 1) throw new Error("INVALID_RELEASE_CHANGELOG");
    if (breaks.some((part) => part.slice("Breaking".length).trim() !== "")) breaking = true;
    selected.push(`## ${section.trim()}`);
  }
  if (!seen.has(target)) throw new Error("INVALID_RELEASE_CHANGELOG");
  return { changelog: selected.join("\n\n"), breaking };
}
