import type {
  DeliveryPull,
  PrMapping,
} from "../../../../../src/application/contracts/pr-delivery.ts";
import type { PreparePrDeps } from "../../../../../src/application/use-cases/delivery/prepare-pr.ts";
import type { PrDeliveryReader } from "../../../../../src/application/ports/pr-delivery.ts";
import { operationMarker } from "../../../../../src/domain/delivery/operation-marker.ts";
import { harness } from "../sync/outbox-fakes.ts";

export const request = {
  projectId: "project-1",
  taskId: "task-26",
  repository: "acme/app",
  issueNumber: 26,
  head: "task/omi-022-pr-creation",
  title: "Deliver task",
  evidence: ["unit suite", "contract suite"],
};
export function preparationHarness() {
  const h = harness();
  let id = 0;
  const state: { issueBody: string; pull?: DeliveryPull; backlink?: string; mapping?: PrMapping } =
    {
      issueBody: "## Acceptance criteria\n- [ ] First criterion\n- [x] Second criterion",
    };
  const reader: PrDeliveryReader = {
    issueBody: () => Promise.resolve(state.issueBody),
    findOpenPull: () => Promise.resolve(state.pull),
    pull: () =>
      state.pull === undefined ? Promise.reject(new Error("NO_PULL")) : Promise.resolve(state.pull),
    hasBacklink: (_repo, _number, body, key) =>
      Promise.resolve(state.backlink === `${body}\n\n${operationMarker(key)}`),
  };
  h.github.onSend = ({ operation, operationKey }) => {
    if (operation.type === "pull_request.create")
      state.pull = {
        number: 100,
        repository: operation.repo,
        head: operation.head,
        base: operation.base,
        body: `${operation.body}\n\n${operationMarker(operationKey)}`,
        state: "open",
      };
    if (operation.type === "issue.comment")
      state.backlink = `${operation.body}\n\n${operationMarker(operationKey)}`;
  };
  const deps: PreparePrDeps = {
    ...h.deps,
    newId: () => `id-${String(++id)}`,
    artifacts: {
      write: (input) => h.artifacts.put(input.path, input.bytes),
      read: h.artifacts.read.bind(h.artifacts),
      manifest: () => ({ schemaVersion: 1, artifacts: [] }),
    },
    unitOfWork: {
      commit: (change) => {
        if (change.outbox === undefined) throw new Error("INTENT_REQUIRED");
        const entry = change.outbox;
        h.outbox.seed({ ...entry, createdAt: change.at, updatedAt: change.at });
        return { ok: true, newVersion: 0, eventSequence: 1 };
      },
    },
    reader,
    mappings: {
      get: () => state.mapping,
      save: (mapping) => {
        state.mapping = mapping;
      },
    },
  };
  return { ...h, deps, state };
}
