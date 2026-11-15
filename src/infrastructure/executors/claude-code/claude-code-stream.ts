import type { ExecutionEventDraft } from "../../processes/execution-event-stream.js";
import type { ExecutionEvent } from "../../../application/contracts/agent-execution.js";
import { effortSchema, type Effort } from "../../../application/contracts/model-capability.js";

type QuotaStatus = Extract<ExecutionEvent, { kind: "quota-signal" }>["status"];

export interface ClaudeInit {
  sessionId?: string;
  model?: string;
  effort?: Effort;
  apiKeySource?: string;
  /** Native skills, plugins and memory paths the CLI listed at startup; absent if none reported. */
  workerEnvironment?: { skills: string[]; plugins: string[]; memoryPaths: string[] };
}

export interface ClaudeResultEvent {
  subtype: string;
  isError: boolean;
  /** `result` text: the final answer on success, the error message otherwise. */
  text: string;
  numTurns?: number;
  apiErrorStatus?: number;
}

export interface ClaudeQuotaObservation {
  status: QuotaStatus;
  limitType?: string;
  resetsAt?: number;
}

/** What one run's stream-json output amounts to, after parsing. Never holds message bodies. */
export interface ClaudeStreamSummary {
  init?: ClaudeInit;
  /** `result` event present but missing a required field. */
  invalidResult: boolean;
  result?: ClaudeResultEvent;
  quota?: ClaudeQuotaObservation;
  toolsUsed: string[];
  eventCount: number;
  unparsedLines: number;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short, non-empty string; longer values are dropped so they can never reach a contract. */
function str(value: unknown, maxChars = 128): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= maxChars ? value : undefined;
}

/** Names from a list whose items are strings or objects with a `name` (skills, plugins). */
function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[]).flatMap((item) => {
    const name = isRecord(item) ? str(item["name"]) : str(item);
    return name === undefined ? [] : [name];
  });
}

/** Paths from a list or from the values of an object (`{ auto: "…" }`); `null` entries are none. */
function paths(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item) => str(item, 1024) ?? []);
  }
  if (isRecord(value)) return Object.values(value).flatMap((item) => str(item, 1024) ?? []);
  return undefined;
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Parses one stream-json line; `undefined` for non-JSON, non-object or untyped lines. */
export function parseClaudeStreamLine(line: string): (JsonObject & { type: string }) | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = parsed["type"];
  return typeof type === "string" ? { ...parsed, type } : undefined;
}

function quotaStatus(raw: unknown): QuotaStatus {
  if (raw === "allowed") return "allowed";
  if (raw === "allowed_warning") return "warning";
  if (raw === "rejected") return "rejected";
  return "unknown";
}

/**
 * Folds stream-json lines into a summary and neutral events, one line at a time. Unknown event
 * types (hook lifecycle, thinking tokens, user/tool results) are counted but not forwarded.
 */
export class ClaudeStreamState {
  private init: ClaudeInit | undefined;
  private invalidResult = false;
  private result: ClaudeResultEvent | undefined;
  private quota: ClaudeQuotaObservation | undefined;
  private readonly toolsUsed: string[] = [];
  private eventCount = 0;
  private unparsedLines = 0;

  ingest(line: string): ExecutionEventDraft[] {
    if (line.trim() === "") return [];
    const event = parseClaudeStreamLine(line);
    if (event === undefined) {
      this.unparsedLines += 1;
      return [{ kind: "diagnostic", code: "unparsed-output" }];
    }
    this.eventCount += 1;
    switch (event.type) {
      case "system":
        return event["subtype"] === "init" ? this.onInit(event) : [];
      case "assistant":
        return this.onAssistant(event);
      case "rate_limit_event":
        return this.onRateLimit(event);
      case "result":
        this.onResult(event);
        return [];
      default:
        return [];
    }
  }

  summary(): ClaudeStreamSummary {
    return {
      ...(this.init === undefined ? {} : { init: this.init }),
      invalidResult: this.invalidResult,
      ...(this.result === undefined ? {} : { result: this.result }),
      ...(this.quota === undefined ? {} : { quota: this.quota }),
      toolsUsed: [...new Set(this.toolsUsed)],
      eventCount: this.eventCount,
      unparsedLines: this.unparsedLines,
    };
  }

  private onInit(event: JsonObject): ExecutionEventDraft[] {
    // A second init would be CLI drift; keep the first.
    if (this.init !== undefined) return [];
    const sessionId = str(event["session_id"]);
    const model = str(event["model"]);
    const effort = effortSchema.safeParse(event["effort"]);
    const apiKeySource = str(event["apiKeySource"]);
    const skills = names(event["skills"]);
    const plugins = names(event["plugins"]);
    const memoryPaths = paths(event["memory_paths"]);
    const reported = skills !== undefined || plugins !== undefined || memoryPaths !== undefined;
    this.init = {
      ...(reported
        ? {
            workerEnvironment: {
              skills: skills ?? [],
              plugins: plugins ?? [],
              memoryPaths: memoryPaths ?? [],
            },
          }
        : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(model === undefined ? {} : { model }),
      ...(effort.success ? { effort: effort.data } : {}),
      ...(apiKeySource === undefined ? {} : { apiKeySource }),
    };
    return [
      {
        kind: "started",
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(model === undefined ? {} : { model }),
      },
    ];
  }

  private onAssistant(event: JsonObject): ExecutionEventDraft[] {
    const message = event["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) return [];
    const drafts: ExecutionEventDraft[] = [];
    for (const block of message["content"] as unknown[]) {
      if (!isRecord(block) || block["type"] !== "tool_use") continue;
      const tool = str(block["name"]);
      if (tool === undefined) continue;
      this.toolsUsed.push(tool);
      drafts.push({ kind: "tool-use", tool });
    }
    return drafts;
  }

  private onRateLimit(event: JsonObject): ExecutionEventDraft[] {
    const info = event["rate_limit_info"];
    if (!isRecord(info)) return [];
    const limitType = str(info["rateLimitType"], 64);
    const resetsAt = wholeNumber(info["resetsAt"]);
    const observation: ClaudeQuotaObservation = {
      status: quotaStatus(info["status"]),
      ...(limitType === undefined ? {} : { limitType }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
    // A rejection is the signal that matters; later "allowed" lines must not hide it.
    if (this.quota?.status !== "rejected" || observation.status === "rejected") {
      this.quota = observation;
    }
    return [{ kind: "quota-signal", ...observation }];
  }

  private onResult(event: JsonObject): void {
    const subtype = str(event["subtype"]);
    const isError = event["is_error"];
    if (subtype === undefined || typeof isError !== "boolean") {
      this.invalidResult = true;
      return;
    }
    const numTurns = wholeNumber(event["num_turns"]);
    const apiErrorStatus = wholeNumber(event["api_error_status"]);
    this.invalidResult = false;
    this.result = {
      subtype,
      isError,
      text: typeof event["result"] === "string" ? event["result"] : "",
      ...(numTurns === undefined ? {} : { numTurns }),
      ...(apiErrorStatus === undefined ? {} : { apiErrorStatus }),
    };
  }
}
