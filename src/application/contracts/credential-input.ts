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
  /^(?:env|environment|process[._]env|.*(?:token|password|passwd|secret|credential|api[_-]?key|private[_-]?key|authorization|cookie).*|CLAUDE_CONFIG_DIR|CODEX_HOME)$/i;
const CREDENTIAL_PATH =
  /(?:^|[\s/\\"'`=:({$])(?:\.env(?:\.[\w.-]+)?|\.aws|\.ssh|\.claude(?:-profiles)?|\.codex(?:-profiles)?|\.netrc|\.npmrc|\.git-credentials|auth\.json|\.?credentials(?:\.json)?|id_(?:rsa|ed25519)|CODEX_HOME|CLAUDE_CONFIG_DIR)(?=$|[\s/\\"'`}:),])/i;
const SECRET_VALUE =
  /(?:\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,})|\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b[A-Z][A-Z0-9_]*\s*=\s*\S+|\b(?:[\w-]{0,64}(?:token|password|secret|api[_-]?key)|authorization|cookie)["']?\s*[:=]\s*["']?[^\s"',}]+)/i;

/** Reject rather than silently altering pinned content. Heuristics plus caller-known secrets. */
export function assertCredentialFree(value: unknown, policy: CredentialPolicy = {}): void {
  const inspectText = (text: string): void => {
    const normalized = text.replaceAll("\\", "/");
    if (
      CREDENTIAL_PATH.test(text) ||
      SECRET_VALUE.test(text) ||
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
