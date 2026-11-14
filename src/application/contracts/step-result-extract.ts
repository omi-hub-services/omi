/** Why no step-result document could be taken from a worker's final message. */
export type StepResultExtraction =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "MISSING" | "AMBIGUOUS" };

const FENCE = /```json[^\S\r\n]*\r?\n([\s\S]*?)```/g;

function tryParse(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** End index (exclusive) of the brace-balanced object starting at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function lastObject(text: string): { readonly value: unknown } | undefined {
  let found: { readonly value: unknown } | undefined;
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    const end = objectEnd(text, i);
    const parsed = end === -1 ? undefined : tryParse(text.slice(i, end));
    if (parsed === undefined) continue;
    found = parsed;
    i = end - 1;
  }
  return found;
}

/**
 * The one step-result document in a worker's final message: the whole text when it is JSON;
 * otherwise the single fenced `json` block (identical repeats count once), otherwise the last
 * JSON object in the text. Different fenced documents are refused, never guessed between.
 * The value is still untrusted: the caller validates it against the step-result schema.
 */
export function extractStepResult(message: string): StepResultExtraction {
  const whole = tryParse(message.trim());
  if (whole !== undefined) return { ok: true, value: whole.value };

  const fenced = [...message.matchAll(FENCE)]
    .map((match) => tryParse(match[1] ?? ""))
    .filter((candidate) => candidate !== undefined);
  const distinct = new Map(fenced.map((candidate) => [JSON.stringify(candidate.value), candidate]));
  if (distinct.size > 1) return { ok: false, reason: "AMBIGUOUS" };
  const only = [...distinct.values()][0] ?? lastObject(message);
  return only === undefined ? { ok: false, reason: "MISSING" } : { ok: true, value: only.value };
}
