import { z } from "zod";
import { mergedPullSchema } from "../../application/contracts/release-delivery.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import type { ReleaseReader } from "../../application/ports/release-delivery.js";
import { RELEASE_BASE, RELEASE_HEAD } from "../../domain/delivery/release-policy.js";
import type { MergedPull } from "../../domain/delivery/release-policy.js";
import type { GithubRestClient } from "./github-rest-client.js";

const repoRef = z.looseObject({ full_name: z.string() });
const pullSchema = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  merged_at: z.string().nullable(),
  head: z.looseObject({ ref: z.string() }),
  base: z.looseObject({ ref: z.string(), repo: repoRef }),
});

export function createGithubReleaseReader(client: GithubRestClient): ReleaseReader {
  async function mergedInto(
    repository: string,
    base: string,
    headFilter?: string,
  ): Promise<MergedPull[]> {
    const owner = repository.split("/")[0] ?? "";
    const head =
      headFilter === undefined ? "" : `&head=${encodeURIComponent(`${owner}:${headFilter}`)}`;
    const found: MergedPull[] = [];
    const pages = await client.readPages(
      `repos/${repository}/pulls?state=closed&base=${encodeURIComponent(base)}${head}&per_page=100`,
      (page) => {
        const parsed = z.array(z.unknown()).safeParse(page);
        if (!parsed.success) return "invalid";
        for (const item of parsed.data) {
          const pull = pullSchema.safeParse(item);
          if (!pull.success) throw new DeliveryError("INVALID_PR_RESPONSE");
          const p = pull.data;
          if (
            p.base.repo.full_name !== repository ||
            p.base.ref !== base ||
            p.html_url !== `https://github.com/${repository}/pull/${String(p.number)}`
          )
            throw new DeliveryError("PR_IDENTITY_MISMATCH");
          if (p.merged_at === null) continue; // closed without merging
          found.push(
            mergedPullSchema.parse({
              number: p.number,
              title: p.title,
              body: p.body ?? "",
              head: p.head.ref,
              mergedAt: p.merged_at,
            }),
          );
        }
        return "continue";
      },
    );
    if (pages.kind !== "complete")
      throw new DeliveryError(pages.kind === "failed" ? pages.code : "INCOMPLETE_PR_LIST");
    return found;
  }
  async function releasePulls(repository: string): Promise<MergedPull[]> {
    const pulls = await mergedInto(repository, RELEASE_BASE, RELEASE_HEAD);
    return pulls.filter((p) => p.head === RELEASE_HEAD);
  }
  return {
    mergedReleasePulls: releasePulls,
    async lastReleaseMergedAt(repository) {
      const releases = await mergedInto(repository, RELEASE_BASE, RELEASE_HEAD);
      const times = releases
        .filter((p) => p.head === RELEASE_HEAD)
        .map((p) => Date.parse(p.mergedAt));
      return times.length === 0 ? undefined : new Date(Math.max(...times)).toISOString();
    },
    mergedDevelopPulls: (repository) => mergedInto(repository, RELEASE_HEAD),
  };
}
