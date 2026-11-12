import { z } from "zod";
import type { GithubRestClient } from "./github-rest-client.js";

export type GraphqlWrite =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: string };

const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() });

/**
 * One GraphQL mutation. Mutations go through `request` (never `queryGraphql`), so a write is only
 * repeated when GitHub is known to have applied nothing. Error text from GitHub is never kept.
 */
export async function writeGraphql(
  client: GithubRestClient,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<GraphqlWrite> {
  const result = await client.request({
    method: "POST",
    path: "graphql",
    body: { query, variables },
  });
  if (result.kind !== "ok") return { ok: false, code: result.code };
  const parsed = envelope.safeParse(result.json);
  if (!parsed.success) return { ok: false, code: "INVALID_RESPONSE" };
  if ((parsed.data.errors?.length ?? 0) > 0) return { ok: false, code: "GRAPHQL_ERRORS" };
  return { ok: true, data: parsed.data.data };
}

/** Writes one Project item field: a single-select option or a text value. */
export const SET_FIELD_MUTATION = `mutation SetField($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) {
    projectV2Item { id }
  }
}`;
