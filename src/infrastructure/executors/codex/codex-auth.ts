import { join } from "node:path";
import { z } from "zod";
import { readBoundedText } from "../../processes/read-bounded-text.js";

const subscriptionCacheSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }),
});

/** Validate in memory only. Never expose fields, rewrite auth or refresh tokens. */
export async function inspectCodexAuth(
  profileHome: string,
): Promise<"ready" | "login-required" | "unsupported-auth-mode"> {
  const text = await readBoundedText(join(profileHome, "auth.json"), 64_000);
  if (text === undefined) return "login-required";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "login-required";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "login-required";
  const record = value as Record<string, unknown>;
  if (
    (record["OPENAI_API_KEY"] !== undefined && record["OPENAI_API_KEY"] !== null) ||
    (record["auth_mode"] !== undefined && record["auth_mode"] !== "chatgpt")
  )
    return "unsupported-auth-mode";
  return subscriptionCacheSchema.safeParse(value).success ? "ready" : "login-required";
}
