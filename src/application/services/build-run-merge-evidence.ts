import type { AttemptRecord } from "../ports/attempt-store.js";
import type { MergeEvidence } from "../contracts/merge-delivery.js";
import type { StepResult } from "../contracts/result.js";

/** Only verified, durably accepted step results may supply review facts to the merge gate. */
export function buildRunMergeEvidence(
  entries: readonly {
    readonly attempt: AttemptRecord;
    readonly result: StepResult;
    readonly reviewBody?: string;
  }[],
  headSha: string,
  allStepsSucceeded: boolean,
): MergeEvidence {
  const authors = entries.filter(({ attempt }) => attempt.role.id !== "reviewer");
  const review = [...entries]
    .reverse()
    .find(
      ({ attempt, result }) =>
        attempt.role.id === "reviewer" && result.revision?.headSha === headSha,
    );
  return {
    authorRunIds: authors.map(({ attempt }) => attempt.id),
    authorAgentIds: authors.map(({ attempt }) => attempt.id),
    workflowGatesPassed: allStepsSucceeded,
    unresolvedMandatoryFindings: entries.reduce(
      (count, { result }) =>
        count +
        result.findings.filter(
          (finding) => finding.severity === "major" || finding.severity === "blocker",
        ).length,
      0,
    ),
    ...(review?.result.revision === undefined
      ? {}
      : {
          review: {
            reviewerRunId: review.attempt.id,
            reviewerAgentId: review.attempt.id,
            headSha: review.result.revision.headSha,
            baseSha: review.result.revision.baseSha,
            verdict: review.result.status === "succeeded" ? ("pass" as const) : ("fail" as const),
            body: review.reviewBody ?? review.result.summary,
          },
        }),
  };
}

export function createRunMergeEvidenceReader(
  source: import("../ports/run-delivery-source.js").RunDeliverySource,
  artifacts: import("../ports/artifact-store.js").ArtifactStore,
): import("../ports/merge-delivery.js").MergeEvidenceReader {
  return {
    read(projectId, taskId, headSha) {
      const { entries, allStepsSucceeded } = source.read(projectId, taskId);
      const reviewed = entries.map((entry) => {
        if (entry.attempt.role.id !== "reviewer") return entry;
        const reports = entry.result.artifacts.map(({ path, sha256 }) => {
          // An accepted result always carries the runtime's hash; anything else fails closed.
          if (sha256 === undefined) throw new Error("ARTIFACT_HASH_MISSING");
          return new TextDecoder("utf-8", { fatal: true }).decode(artifacts.read({ path, sha256 }));
        });
        const body = reports.find((report) => /^AC-\d+:/m.test(report)) ?? entry.result.summary;
        if (body.length > 60_000) throw new Error("REVIEW_REPORT_TOO_LARGE");
        return { ...entry, reviewBody: body };
      });
      return buildRunMergeEvidence(reviewed, headSha, allStepsSucceeded);
    },
  };
}
