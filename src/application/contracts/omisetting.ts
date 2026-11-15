import { z } from "zod";
import { identifierSchema } from "./identifiers.js";
import type { CredentialPolicy } from "./credential-input.js";

const profileId = identifierSchema.describe(
  "Choose a unique profile name, e.g. codex-main; also names its private auth store.",
);
const tokenAuth = z
  .strictObject({
    type: z.literal("token").describe("Use token for a Claude subscription profile."),
    token: z
      .string()
      .min(1)
      .describe(
        "Run claude setup-token for this account: a 1-year token with user:inference scope. Rotate yearly; never paste it into prompts or logs.",
      ),
  })
  .describe("Claude authentication; obtain a separate setup-token for each profile.");
const loginAuth = z
  .strictObject({
    type: z
      .literal("login")
      .describe(
        "Run omi profile login <id> once from Windows PowerShell. Codex stores rotating ChatGPT refresh credentials only in its writable profile store, never here.",
      ),
  })
  .describe("Codex ChatGPT subscription login; no static token or API key.");

export const omisettingSchema = z.strictObject({
  $schema: z
    .string()
    .optional()
    .describe(
      "VS Code schema reference: ./tool/node_modules/omi-squad/schemas/omisetting.schema.json.",
    ),
  version: z.literal(1).describe("Settings format version; use 1."),
  github: z
    .strictObject({
      token: z
        .string()
        .min(1)
        .describe(
          "Create a fine-grained GitHub PAT for an account other than the PO, limited to this repository: Metadata Read; Contents, Pull requests and Issues Read and write; Workflows Read and write only if editing .github/workflows; organization Projects Read and write (ADR-0043 Decision 4).",
        ),
      gitUser: z
        .strictObject({
          name: z
            .string()
            .min(1)
            .describe("Git author name of the worker account; choose its GitHub display name."),
          email: z
            .email()
            .describe(
              "Git author email of the worker account; copy its verified or GitHub noreply email from GitHub Settings > Emails.",
            ),
        })
        .describe("Git commit identity for the worker account."),
    })
    .describe(
      "One shared GitHub worker account; obtain its PAT in GitHub Settings > Developer settings > Fine-grained tokens.",
    ),
  profiles: z
    .array(
      z.discriminatedUnion("tool", [
        z.strictObject({
          id: profileId,
          tool: z.literal("claude").describe("Select Claude Code for this profile."),
          auth: tokenAuth,
        }),
        z.strictObject({
          id: profileId,
          tool: z.literal("codex").describe("Select Codex with a ChatGPT plan for this profile."),
          auth: loginAuth,
        }),
      ]),
    )
    .min(1)
    .describe("Worker accounts; choose unique IDs and authenticate each with its tool.")
    .superRefine((profiles, ctx) => {
      const seen = new Set<string>();
      profiles.forEach((profile, index) => {
        if (seen.has(profile.id))
          ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate profile ID" });
        seen.add(profile.id);
      });
    }),
  docker: z
    .strictObject({
      container: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
        .optional()
        .describe("Docker container name; defaults to omi-<repo>."),
      image: z
        .string()
        .regex(/^omi-worker:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
        .optional()
        .describe("Locally built image tag; defaults to omi-worker:<framework-version>."),
      memory: z
        .string()
        .regex(/^\d+[bkmg]$/i)
        .optional()
        .describe("Docker memory limit, e.g. 8g; defaults to 8g."),
      memoryWarningPercent: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Doctor memory warning threshold, percent; default 80."),
      workVolumeWarningGb: z
        .number()
        .positive()
        .optional()
        .describe("Doctor work volume warning threshold in GB; default 20."),
    })
    .optional()
    .describe("Enables the project Docker runtime; omit to retain the existing WSL binding."),
});
export type OmiSetting = z.infer<typeof omisettingSchema>;
export interface WorkerCredentials {
  readonly githubToken?: string;
  readonly token?: string;
}

/** Only paths and fixed reasons survive validation; Zod messages can include untrusted values. */
export function parseOmiSetting(value: unknown): OmiSetting {
  const result = omisettingSchema.safeParse(value);
  if (result.success) return result.data;
  const paths = result.error.issues.flatMap((issue) => {
    const path = issue.path.reduce<string>(
      (text, part) =>
        typeof part === "number"
          ? `${text}[${String(part)}]`
          : `${text}${text ? "." : ""}${String(part)}`,
      "",
    );
    return [
      `${path || "settings"}: ${issue.code === "unrecognized_keys" ? "unknown fields" : "invalid or missing value"}`,
    ];
  });
  throw new Error(paths.join("; "));
}

export function settingsCredentialPolicy(settings: OmiSetting): CredentialPolicy {
  return {
    sensitiveValues: [
      settings.github.token,
      ...settings.profiles.flatMap((profile) =>
        profile.auth.type === "token" ? [profile.auth.token] : [],
      ),
    ],
  };
}
