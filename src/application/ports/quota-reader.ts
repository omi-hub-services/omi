import type { QuotaReading } from "../../domain/profiles/quota-policy.js";

export interface QuotaProfileRef {
  readonly profileId: string;
  readonly tool: "claude-code" | "codex";
  /** Isolated profile directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), never a token. */
  readonly credentialRef: string;
}

export interface QuotaReadResult {
  /** Null when neither the tool nor a cached reading could say. A cached one keeps its age. */
  readonly reading: QuotaReading | null;
  /** Why the live read failed (`HTTP 401`, `token expired`); never a token or response body. */
  readonly note: string | null;
}

/**
 * Reads what a subscription profile has left. Adapters keep tokens in memory only, never store,
 * print or log them, and never refresh them. They fall back to the last good reading, keeping its
 * original `observedAt`, so the policy can mark it stale. `probe` asks for one minimal live
 * subscription call to refresh a stale reading, where the tool has no free way to read quota.
 */
export interface QuotaReader {
  read(
    profile: QuotaProfileRef,
    options: { readonly now: number; readonly probe: boolean },
  ): Promise<QuotaReadResult>;
}
