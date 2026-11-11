import { z } from "zod";
import { absolutePathSchema, identifierSchema } from "./identifiers.js";
import { effortSchema, executorSchema, modelNameSchema } from "./model-capability.js";

// Tool-neutral types of the AgentExecutor port (architecture.md §7, design-patterns.md §2).
// Nothing here names a Claude Code or Codex flag, event or file. Adapters map their CLI onto
// these shapes; use cases and the state layer see only these.

/**
 * What the worker may do in its workspace. Adapters translate each level to their own tool or
 * sandbox settings. A level that needs shell command execution is deliberately absent until a
 * decision covers it (ADR-0023).
 */
export const ACCESS_LEVELS = ["read-only", "workspace-write"] as const;
export const accessLevelSchema = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

export const MAX_PROMPT_CHARS = 1_000_000;
export const MAX_EXECUTION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const probeRequestSchema = z.strictObject({
  /** Isolated state directory of one profile (Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`). */
  profileHome: absolutePathSchema,
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const PROBE_STATUSES = [
  "ready",
  "login-required",
  "unsupported-auth-mode",
  "unsupported-version",
  "unavailable",
] as const;
export const COMPATIBILITIES = ["supported", "unsupported", "unknown"] as const;

/** Probing spends no model quota and never returns account identifiers. */
export const probeResultSchema = z.strictObject({
  executor: executorSchema,
  status: z.enum(PROBE_STATUSES),
  version: z.string().min(1).max(64).optional(),
  compatibility: z.enum(COMPATIBILITIES),
  /** Human-readable supported CLI version range of the adapter. */
  supportedRange: z.string().min(1).max(64),
  subscriptionType: z.string().min(1).max(64).optional(),
  loginExpiresAt: z.string().min(1).max(64).optional(),
  /** Fixed-category, redacted note; never raw CLI output. */
  diagnostic: z.string().min(1).max(500).optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const executionRequestSchema = z.strictObject({
  attemptId: identifierSchema,
  /** Working directory the worker edits: a framework-created task worktree. */
  workspace: absolutePathSchema,
  profileHome: absolutePathSchema,
  /** Delivered over stdin, never as a command-line argument. */
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  /** Always explicit: the default model differs per profile (ADR-0013 finding 4). */
  model: modelNameSchema,
  effort: effortSchema,
  access: accessLevelSchema,
  /** Maximum run time. On expiry the adapter cancels, then escalates. */
  timeoutMs: z.number().int().positive().max(MAX_EXECUTION_TIMEOUT_MS),
});
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;

/** Neutral id; carries no process or SDK object. Valid only for the adapter that issued it. */
export const executionHandleSchema = z.strictObject({
  executionId: identifierSchema,
  attemptId: identifierSchema,
  executor: executorSchema,
});
export type ExecutionHandle = z.infer<typeof executionHandleSchema>;

const sequence = z.number().int().nonnegative();

/** Adapter-neutral progress signal. Carries no message text, tool input or tool output. */
export const executionEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    sequence,
    sessionId: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ kind: z.literal("tool-use"), sequence, tool: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("quota-signal"),
    sequence,
    status: z.enum(["allowed", "warning", "rejected", "unknown"]),
    limitType: z.string().min(1).max(64).optional(),
    /** Epoch seconds. */
    resetsAt: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ kind: z.literal("diagnostic"), sequence, code: z.enum(["unparsed-output"]) }),
  z.strictObject({ kind: z.literal("finished"), sequence, outcome: z.string().min(1).max(64) }),
]);
export type ExecutionEvent = z.infer<typeof executionEventSchema>;

export const EXECUTION_OUTCOMES = [
  "succeeded",
  "cancelled",
  "timed-out",
  "usage-limit",
  "auth-required",
  "unsupported-model-or-effort",
  "malformed-output",
  "failed",
] as const;
export const executionOutcomeSchema = z.enum(EXECUTION_OUTCOMES);
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

/**
 * One attempt's result as the adapter observed it. It reports process facts, not task
 * completion: `succeeded` never makes a task Done (architecture.md §6).
 */
export const executionResultSchema = z.strictObject({
  executionId: identifierSchema,
  attemptId: identifierSchema,
  executor: executorSchema,
  outcome: executionOutcomeSchema,
  /** Stable machine-readable code refining `outcome`; never free text from the CLI. */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(16).nullable(),
  durationMs: z.number().nonnegative(),
  sessionId: z.string().min(1).max(128).optional(),
  /** `actual` is what the CLI reported at startup; absent when it did not report it. */
  model: z.strictObject({
    requested: modelNameSchema,
    actual: z.string().min(1).max(128).optional(),
  }),
  effort: z.strictObject({ requested: effortSchema, actual: effortSchema.optional() }),
  authMode: z.enum(["subscription", "api-key", "unknown"]),
  numTurns: z.number().int().nonnegative().optional(),
  /**
   * What the CLI said it started with: native skills, plugins and auto-memory paths. Workers must
   * report all three empty (ADR-0019, decision update 2026-11-11); absent when not reported.
   */
  workerEnvironment: z
    .strictObject({
      skills: z.array(z.string().min(1).max(128)).max(256),
      plugins: z.array(z.string().min(1).max(128)).max(256),
      memoryPaths: z.array(z.string().min(1).max(1024)).max(256),
    })
    .optional(),
  /** The worker's final answer; present only for `succeeded`. */
  finalMessage: z.string().max(100_000).optional(),
  quota: z
    .strictObject({
      limitType: z.string().min(1).max(64).optional(),
      /** Epoch seconds. */
      resetsAt: z.number().int().nonnegative().optional(),
    })
    .optional(),
  toolsUsed: z.array(z.string().min(1).max(128)),
  eventCount: z.number().int().nonnegative(),
  unparsedLines: z.number().int().nonnegative(),
  /** Redacted, bounded excerpt of the CLI's error text for non-success outcomes. */
  diagnostic: z.string().min(1).max(2000).optional(),
  /** The grace period expired and the process group had to be killed. */
  escalated: z.boolean(),
  /** Process-group members were still alive at exit and were killed. */
  leftoverProcessesKilled: z.boolean(),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;
