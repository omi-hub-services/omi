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
const CREDENTIAL_PATH =
  /(?:^|[\s/\\"'`=:({$])(?:\.env(?:\.[\w.-]+)?|\.aws|\.ssh|\.claude(?:-profiles)?|\.codex(?:-profiles)?|\.netrc|\.npmrc|\.git-credentials|auth\.json|\.credentials(?:\.json)?|credentials\.json|id_(?:rsa|ed25519)|CODEX_HOME|CLAUDE_CONFIG_DIR)(?=$|[\s/\\"'`}:),])|[/\\]credentials(?=$|[\s/\\"'`}:),])/i;
// Keep env names case-sensitive and require a secret-bearing UPPER_SNAKE segment.
const SECRET_ENV_ASSIGNMENT =
  /\b(?:[A-Z][A-Z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_[A-Z0-9]+)*\s*=(?!=)\s*["']?[^\s"'`;{},]{4,}/;
const SECRET_VALUE =
  /(?:\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|xox[abprs]-[\w-]{8,}|glpat-[\w-]{8,})|\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|oauth[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key|private[_-]?key|authorization|cookie)["']?\s*[:=](?!=)\s*["']?[^\s"',}]+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+)/i;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/;

/** Reject rather than silently altering pinned content. Heuristics plus caller-known secrets. */
export function assertCredentialFree(value: unknown, policy: CredentialPolicy = {}): void {
  const inspectText = (text: string): void => {
    const normalized = text.replaceAll("\\", "/");
    if (
      CREDENTIAL_PATH.test(text) ||
      SECRET_ENV_ASSIGNMENT.test(text) ||
      SECRET_VALUE.test(text) ||
      AWS_ACCESS_KEY.test(text) ||
      /(?:^|[\s/])\.config\/gh(?:\/|$)/i.test(normalized) ||
      /(?:^|[\s/])\.omi-squad\/local\/(?:credentials|profiles)(?:\/|$)/i.test(normalized) ||
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
