import { z } from "zod";
import { effortSchema, type Effort } from "../../../application/contracts/model-capability.js";
import type { ExecutionEventDraft } from "../../processes/execution-event-stream.js";

const shortText = z.string().min(1).max(128);
const envelopeSchema = z.looseObject({ type: z.string().min(1).max(128) });
const threadSchema = z.looseObject({
  thread_id: shortText,
  // Optional extensions: absent in the ADR-0021 capture; never infer them from the request.
  model: shortText.optional(),
  model_reasoning_effort: effortSchema.optional(),
});
const errorSchema = z.looseObject({
  message: z.string().max(16_000),
  code: shortText.optional(),
});
const windowSchema = z.looseObject({
  usedPercent: z.number().nonnegative(),
  windowDurationMins: z.number().int().positive(),
  resetsAt: z.number().int().nonnegative(),
});
const limitsSchema = z.looseObject({
  primary: windowSchema.nullable().optional(),
  secondary: windowSchema.nullable().optional(),
});
const itemSchema = z.looseObject({ id: shortText, type: shortText });
const TOOL_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

export interface CodexQuotaObservation {
  status: "allowed" | "warning" | "rejected";
  limitType: "primary" | "secondary";
  resetsAt: number;
}

export interface CodexStreamSummary {
  sessionId?: string;
  model?: string;
  effort?: Effort;
  completedTurns: number;
  errorSeen: boolean;
  errorText: string;
  errorCodes: string[];
  quota?: CodexQuotaObservation;
  toolsUsed: string[];
  eventCount: number;
  unparsedLines: number;
}

/** JSONL boundary: known event shapes are validated; unknown typed events are ignored. */
export class CodexStreamState {
  private thread: z.infer<typeof threadSchema> | undefined;
  private completedTurns = 0;
  private errorSeen = false;
  private errorText = "";
  private readonly errorCodes = new Set<string>();
  private quota: CodexQuotaObservation | undefined;
  private readonly toolsUsed = new Set<string>();
  private readonly toolItems = new Set<string>();
  private eventCount = 0;
  private unparsedLines = 0;

  ingest(line: string): ExecutionEventDraft[] {
    if (line.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.malformed();
    }
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success) return this.malformed();
    this.eventCount += 1;
    const event = parsed.data;
    switch (event.type) {
      case "thread.started": {
        const thread = threadSchema.safeParse(event);
        if (!thread.success || this.thread !== undefined) return this.malformed();
        this.thread = thread.data;
        return [
          {
            kind: "started",
            sessionId: thread.data.thread_id,
            ...(thread.data.model === undefined ? {} : { model: thread.data.model }),
          },
        ];
      }
      case "turn.completed":
        this.completedTurns += 1;
        return [];
      case "turn.failed":
      case "error": {
        this.errorSeen = true;
        const error = errorSchema.safeParse(event.type === "turn.failed" ? event["error"] : event);
        if (!error.success) return this.malformed();
        this.errorText = `${this.errorText}\n${error.data.message}`.slice(0, 16_000);
        if (error.data.code !== undefined && this.errorCodes.size < 100)
          this.errorCodes.add(error.data.code);
        return [];
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = itemSchema.safeParse(event["item"]);
        if (!item.success) return this.malformed();
        const { id, type } = item.data;
        if (!TOOL_TYPES.has(type) || this.toolItems.has(id) || this.toolItems.size >= 10_000)
          return [];
        this.toolItems.add(id);
        this.toolsUsed.add(type);
        return [{ kind: "tool-use", tool: type }];
      }
      case "rate_limits.updated":
        return this.onLimits(event["rateLimits"]);
      default:
        return [];
    }
  }

  summary(): CodexStreamSummary {
    return {
      ...(this.thread === undefined ? {} : { sessionId: this.thread.thread_id }),
      ...(this.thread?.model === undefined ? {} : { model: this.thread.model }),
      ...(this.thread?.model_reasoning_effort === undefined
        ? {}
        : { effort: this.thread.model_reasoning_effort }),
      completedTurns: this.completedTurns,
      errorSeen: this.errorSeen,
      errorText: this.errorText,
      errorCodes: [...this.errorCodes],
      ...(this.quota === undefined ? {} : { quota: this.quota }),
      toolsUsed: [...this.toolsUsed],
      eventCount: this.eventCount,
      unparsedLines: this.unparsedLines,
    };
  }

  private malformed(): ExecutionEventDraft[] {
    this.unparsedLines += 1;
    return [{ kind: "diagnostic", code: "unparsed-output" }];
  }

  private onLimits(value: unknown): ExecutionEventDraft[] {
    const parsed = limitsSchema.safeParse(value);
    if (!parsed.success) return this.malformed();
    const drafts: ExecutionEventDraft[] = [];
    const rank = { allowed: 0, warning: 1, rejected: 2 };
    for (const limitType of ["primary", "secondary"] as const) {
      const window = parsed.data[limitType];
      if (window === undefined || window === null) continue;
      const status =
        window.usedPercent >= 100 ? "rejected" : window.usedPercent >= 90 ? "warning" : "allowed";
      const observation: CodexQuotaObservation = { status, limitType, resetsAt: window.resetsAt };
      // Preserve exhaustion even when a later observation reports another window as allowed.
      if (this.quota === undefined || rank[status] >= rank[this.quota.status])
        this.quota = observation;
      drafts.push({ kind: "quota-signal", ...observation });
    }
    return drafts;
  }
}
