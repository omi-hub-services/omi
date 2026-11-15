// OMI-003 test-only boundary validation. No auth fields are returned to callers.
import { z } from "zod";

export const resultSchema = z.strictObject({
  codename: z.string(),
  changedFiles: z.array(z.string()),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Native JSON errors can include the input, which may contain credentials or model output.
    throw new Error("invalid JSON at Codex PoC boundary");
  }
}

export function validateResult(text: string): z.infer<typeof resultSchema> {
  const parsed = resultSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new Error("Codex result violates output schema");
  return parsed.data;
}

export function subscriptionAuthMode(text: string): "chatgpt" {
  const subscription = z
    .object({
      auth_mode: z.literal("chatgpt"),
      OPENAI_API_KEY: z.null().optional(),
      tokens: z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }),
    })
    .safeParse(parseJson(text));
  if (!subscription.success)
    throw new Error("profile must contain subscription auth without an API key");
  return "chatgpt";
}
