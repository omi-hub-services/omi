/** Boundary callers supply known environment values and resolved profile roots; no env is read here. */
export interface CredentialPolicy {
  readonly sensitiveValues?: readonly string[];
  readonly credentialRoots?: readonly string[];
}

export class CredentialInputError extends Error {
  override readonly name = "CredentialInputError";
  readonly code = "CREDENTIAL_INPUT";

  constructor() {
    super("Input contains credential material or a credential file reference");
  }
}

const CREDENTIAL_KEY =
  /^(?:env|environment|process[._]env|(?:access|refresh|id|auth|session|bearer|oauth)[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key|private[_-]?key|credentials?|authorization|cookies?|CLAUDE_CONFIG_DIR|CODEX_HOME)$/i;
// Config directories and variable names are documentation, not credential file references.
const CREDENTIAL_PATH =
  /(?:^|[\s/\\"'`=:({$])(?:\.env(?:\.[\w.-]+)?|\.netrc|\.git-credentials|auth\.json|\.credentials(?:\.json)?|credentials\.json|\.aws[/\\]credentials|id_(?:rsa|ed25519))(?=$|[\s/\\"'`}:),])|[/\\]credentials(?=$|["'`}:),])/i;
const SECRET_ASSIGNMENT =
  /(?:^|[^\w$-])(?:[a-z][a-z0-9]*[_-])*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|oauth[_-]?token|token|password|passwd|pass|pgpassword|secret|client[_-]?secret|api[_-]?key|private[_-]?key|credentials?|authorization|cookies?)(?:[_-][a-z0-9]+)*["']?\s*[:=](?!=)[ \t]*/gi;
const BEARER_VALUE = /\bBearer[ \t]+/gi;
const NPM_AUTH_ASSIGNMENT = /(?:^|\n)\s*(?:\/\/[^\s=]+:)?_(?:authToken|auth|password)\s*=\s*\S+/i;
const SECRET_VALUE =
  /(?:\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|xox[abprs]-[\w-]{8,}|glpat-[\w-]{8,})|\beyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+)/i;

/** Literal heuristic only: do not interpret identifiers, calls, types or template expressions. */
function isSecretLiteral(text: string, allowOpaqueWord: boolean): boolean {
  const quoted =
    /^(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|`((?:\\.|[^`\\\r\n])*)`)(?=$|[\s,;})\]])/.exec(
      text,
    );
  if (quoted !== null) {
    const value = quoted[1] ?? quoted[2] ?? quoted[3] ?? "";
    const rest = text.slice(quoted[0].length).trimStart();
    return value.length > 0 && !/\$\{|\{\{|<%/.test(value) && !/^(?:[.(+]|\[|\?\.)/.test(rest);
  }
  const bare = /^([a-z0-9_+/~=-]{8,})(?=$|[\s,;})\]"'`])/i.exec(text);
  if (bare === null) return false;
  const value = bare[1] ?? "";
  const rest = text.slice(bare[0].length).trimStart();
  return (
    // Short words and ordinary identifiers are not evidence of a secret. Long opaque words,
    // digits or token punctuation are; this deliberately is not an entropy calculation.
    (/[0-9+/~=-]/.test(value) || (allowOpaqueWord && value.length >= 24)) &&
    !/^(?:[.(]|\?\.|\+|\$\{)/.test(rest)
  );
}

function containsSecretLiteral(text: string): boolean {
  return [SECRET_ASSIGNMENT, BEARER_VALUE].some((pattern) =>
    Array.from(text.matchAll(pattern)).some((match) =>
      isSecretLiteral(text.slice(match.index + match[0].length), pattern === BEARER_VALUE),
    ),
  );
}
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/;

/** Reject rather than silently altering pinned content. Heuristics plus caller-known secrets. */
export function assertCredentialFree(value: unknown, policy: CredentialPolicy = {}): void {
  const inspectText = (text: string): void => {
    const normalized = text.replaceAll("\\", "/");
    if (
      CREDENTIAL_PATH.test(text) ||
      containsSecretLiteral(text) ||
      NPM_AUTH_ASSIGNMENT.test(text) ||
      SECRET_VALUE.test(text) ||
      AWS_ACCESS_KEY.test(text) ||
      /(?:^|[\s/])\.config\/gh\/hosts\.yml(?=$|[\s"'`}:),])/i.test(normalized) ||
      policy.sensitiveValues?.some((secret) => secret.length > 0 && text.includes(secret)) ===
        true ||
      policy.credentialRoots?.some((root) => {
        const canonical = root.replaceAll("\\", "/").replace(/\/+$/, "");
        return canonical.length > 0 && normalized.includes(canonical);
      }) === true
    ) {
      throw new CredentialInputError();
    }
  };

  const visit = (item: unknown): void => {
    if (typeof item === "string") inspectText(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (CREDENTIAL_KEY.test(key)) throw new CredentialInputError();
        inspectText(key);
        visit(child);
      }
    }
  };
  visit(value);
}
