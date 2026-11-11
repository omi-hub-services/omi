import {
  githubOperationSchema,
  parseGithubOperationPayload,
} from "../contracts/github-operation.js";
import type { GithubOperation } from "../contracts/github-operation.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type { StateUnitOfWork } from "../ports/state-unit-of-work.js";
import { operationMarker } from "../../domain/delivery/operation-marker.js";
import { DeliveryError } from "../ports/pr-delivery.js";

export interface GithubOperationQueueDeps {
  readonly artifacts: ArtifactStore;
  readonly outbox: OutboxStore;
  readonly unitOfWork: StateUnitOfWork;
  readonly now: () => number;
  readonly newId: () => string;
}

/** Queue only; the normal flush/reconcile use cases own the remote side effect. */
export function queueGithubOperation(
  deps: GithubOperationQueueDeps,
  operationKey: string,
  input: GithubOperation,
): { state: string; remoteIdentity: string | null } {
  operationMarker(operationKey);
  const operation = githubOperationSchema.parse(input);
  const existing = deps.outbox.get(operationKey);
  if (existing !== undefined) {
    const loaded = parseGithubOperationPayload(
      deps.artifacts.read({ path: existing.payloadRef, sha256: existing.payloadHash }),
      existing.kind,
    );
    if (!loaded.ok || JSON.stringify(loaded.operation) !== JSON.stringify(operation)) {
      throw new DeliveryError("OPERATION_KEY_CONFLICT");
    }
    return { state: existing.state, remoteIdentity: existing.remoteIdentity };
  }
  const at = new Date(deps.now()).toISOString();
  const id = deps.newId();
  const payload = deps.artifacts.write({
    id,
    path: `github-operations/${id}.json`,
    bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, operation })),
    classification: "github-operation",
    createdAt: at,
  });
  const committed = deps.unitOfWork.commit({
    target: { kind: "outbox_intent" },
    at,
    event: {
      eventId: deps.newId(),
      kind: `${operation.type}-requested`,
      subject: operationKey,
      correlationId: operationKey,
      payload: JSON.stringify(operation),
    },
    outbox: {
      operationKey,
      kind: operation.type,
      subject: operationKey,
      payloadRef: payload.path,
      payloadHash: payload.sha256,
    },
  });
  if (!committed.ok) throw new DeliveryError(committed.reason);
  return { state: "pending", remoteIdentity: null };
}
