import {
  githubOperationSchema,
  parseGithubOperationPayload,
} from "../contracts/github-operation.js";
import type { GithubOperation } from "../contracts/github-operation.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type { StateUnitOfWork } from "../ports/state-unit-of-work.js";
import { ProjectInitializationError } from "../ports/github-project-reader.js";

export interface ProjectTemplateQueueDeps {
  readonly artifacts: ArtifactStore;
  readonly outbox: OutboxStore;
  readonly unitOfWork: StateUnitOfWork;
  readonly now: () => number;
  readonly newId: () => string;
}

/** Queue only; the normal flush/reconcile use cases own the remote side effect. */
export function queueProjectTemplate(
  deps: ProjectTemplateQueueDeps,
  operationKey: string,
  input: Extract<GithubOperation, { type: "project.copy" }>,
): { state: string; remoteIdentity: string | null } {
  const operation = githubOperationSchema.parse(input);
  const existing = deps.outbox.get(operationKey);
  if (existing !== undefined) {
    const loaded = parseGithubOperationPayload(
      deps.artifacts.read({ path: existing.payloadRef, sha256: existing.payloadHash }),
      existing.kind,
    );
    if (!loaded.ok || JSON.stringify(loaded.operation) !== JSON.stringify(operation)) {
      throw new ProjectInitializationError("OPERATION_KEY_CONFLICT");
    }
    return { state: existing.state, remoteIdentity: existing.remoteIdentity };
  }
  const at = new Date(deps.now()).toISOString();
  const id = deps.newId();
  const payload = deps.artifacts.write({
    id,
    path: `project-init/${id}.json`,
    bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, operation })),
    classification: "github-operation",
    createdAt: at,
  });
  const committed = deps.unitOfWork.commit({
    target: { kind: "outbox_intent" },
    at,
    event: {
      eventId: deps.newId(),
      kind: "project.copy-requested",
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
  if (!committed.ok) throw new ProjectInitializationError(committed.reason);
  return { state: "pending", remoteIdentity: null };
}
