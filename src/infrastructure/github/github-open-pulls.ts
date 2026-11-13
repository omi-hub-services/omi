import { z } from "zod";
import type { OpenPull, OpenPullReader } from "../../application/ports/open-pull-reader.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import type { GithubRestClient, PageVisit } from "./github-rest-client.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const pullPage = z.array(
  z.looseObject({
    number: z.number().int().positive(),
    title: z.string(),
    draft: z.boolean().optional(),
    body: z.string().nullable(),
    head: z.looseObject({ ref: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
);

/**
 * Open pull requests of one repository over the REST client, read to the last page. A refused,
 * malformed or truncated listing throws, so a failed read never shows as "no open PRs". Read only.
 */
export function createGithubOpenPulls(client: GithubRestClient): OpenPullReader {
  return {
    async listOpen(repository) {
      if (!REPOSITORY.test(repository)) throw new DeliveryError("INVALID_REPOSITORY");
      const pulls: OpenPull[] = [];
      const errors: string[] = [];
      const result = await client.readPages(
        `repos/${repository}/pulls?state=open&per_page=100`,
        (page): PageVisit => {
          const parsed = pullPage.safeParse(page);
          if (!parsed.success) {
            errors.push("INVALID_PR_LIST");
            return "invalid";
          }
          for (const pull of parsed.data) {
            pulls.push({
              number: pull.number,
              title: pull.title,
              headRef: pull.head.ref,
              headSha: pull.head.sha,
              draft: pull.draft === true,
              body: pull.body ?? "",
            });
          }
          return "continue";
        },
      );
      if (errors.length > 0) throw new DeliveryError("INVALID_PR_LIST");
      if (result.kind !== "complete") {
        throw new DeliveryError(result.kind === "failed" ? result.code : "INCOMPLETE_LISTING");
      }
      return pulls;
    },
  };
}
