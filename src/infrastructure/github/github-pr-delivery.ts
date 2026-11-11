import { z } from "zod";
import type { DeliveryPull } from "../../application/contracts/pr-delivery.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import type { PrDeliveryReader } from "../../application/ports/pr-delivery.js";
import { operationMarker } from "../../domain/delivery/operation-marker.js";
import type { GithubRestClient } from "./github-rest-client.js";

const numberSchema = z.number().int().positive();
const issueSchema = z.looseObject({ number: numberSchema, body: z.string(), html_url: z.string() });
const pullSchema = issueSchema.extend({
  state: z.enum(["open", "closed"]),
  head: z.looseObject({ ref: z.string(), repo: z.looseObject({ full_name: z.string() }) }),
  base: z.looseObject({ ref: z.string(), repo: z.looseObject({ full_name: z.string() }) }),
});
const commentSchema = z.looseObject({ id: numberSchema, body: z.string() });

export function createGithubPrDelivery(client: GithubRestClient): PrDeliveryReader {
  async function read(path: string): Promise<unknown> {
    const result = await client.request({ method: "GET", path });
    if (result.kind !== "ok") throw new DeliveryError(result.code);
    return result.json;
  }
  function parsePull(value: unknown, repository: string): DeliveryPull {
    const parsed = pullSchema.safeParse(value);
    if (!parsed.success) throw new DeliveryError("INVALID_PR_RESPONSE");
    const p = parsed.data;
    if (
      p.head.repo.full_name !== repository ||
      p.base.repo.full_name !== repository ||
      p.html_url !== `https://github.com/${repository}/pull/${String(p.number)}`
    )
      throw new DeliveryError("PR_IDENTITY_MISMATCH");
    return {
      number: p.number,
      body: p.body,
      head: p.head.ref,
      base: p.base.ref,
      state: p.state,
      repository,
    };
  }
  return {
    async issueBody(repository, number) {
      const parsed = issueSchema.safeParse(
        await read(`repos/${repository}/issues/${String(number)}`),
      );
      if (!parsed.success) throw new DeliveryError("INVALID_ISSUE_RESPONSE");
      if (
        parsed.data.number !== number ||
        parsed.data.html_url !== `https://github.com/${repository}/issues/${String(number)}` ||
        "pull_request" in parsed.data
      )
        throw new DeliveryError("ISSUE_IDENTITY_MISMATCH");
      return parsed.data.body;
    },
    async findOpenPull(repository, head, base) {
      const owner = repository.split("/")[0] ?? "";
      const found: DeliveryPull[] = [];
      const pages = await client.readPages(
        `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=100`,
        (page) => {
          const parsed = z.array(z.unknown()).safeParse(page);
          if (!parsed.success) return "invalid";
          for (const item of parsed.data) {
            const pull = parsePull(item, repository);
            if (pull.state !== "open" || pull.head !== head || pull.base !== base)
              throw new DeliveryError("PR_FILTER_MISMATCH");
            found.push(pull);
          }
          return "continue";
        },
      );
      if (pages.kind !== "complete")
        throw new DeliveryError(pages.kind === "failed" ? pages.code : "INCOMPLETE_PR_LIST");
      if (found.length > 1) throw new DeliveryError("AMBIGUOUS_PR");
      return found[0];
    },
    async pull(repository, number) {
      const pull = parsePull(await read(`repos/${repository}/pulls/${String(number)}`), repository);
      if (pull.number !== number) throw new DeliveryError("PR_IDENTITY_MISMATCH");
      return pull;
    },
    async hasBacklink(repository, issueNumber, body, key) {
      let found = false;
      const pages = await client.readPages(
        `repos/${repository}/issues/${String(issueNumber)}/comments?per_page=100`,
        (page) => {
          const parsed = z.array(commentSchema).safeParse(page);
          if (!parsed.success) return "invalid";
          found ||= parsed.data.some(
            (comment) => comment.body === `${body}\n\n${operationMarker(key)}`,
          );
          return "continue";
        },
      );
      if (pages.kind !== "complete")
        throw new DeliveryError(pages.kind === "failed" ? pages.code : "INCOMPLETE_COMMENT_LIST");
      return found;
    },
  };
}
