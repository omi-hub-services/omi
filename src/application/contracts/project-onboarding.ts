import { z } from "zod";

/** `new` = empty repository to initialize; `existing` = take over a codebase that already works. */
export const onboardingVariantSchema = z.enum(["new", "existing"]);
export type OnboardingVariant = z.infer<typeof onboardingVariantSchema>;

const detectedLanguageSchema = z.enum([
  "typescript",
  "javascript",
  "go",
  "rust",
  "python",
  "java",
  "dotnet",
]);

/** Facts read from files that exist in the repository root; nothing is guessed or executed. */
export const codebaseDetectionSchema = z.strictObject({
  language: z.union([detectedLanguageSchema, z.literal("unknown")]),
  other_languages: z.array(detectedLanguageSchema),
  package_manager: z.string().optional(),
  commands: z.strictObject({
    test: z.string().optional(),
    build: z.string().optional(),
    lint: z.string().optional(),
  }),
  /** Root files that justified the detection, sorted. */
  evidence: z.array(z.string()),
});
export type CodebaseDetection = z.infer<typeof codebaseDetectionSchema>;

export const onboardingFileActionSchema = z.enum(["would-create", "created", "kept"]);
export const onboardingFileReportSchema = z.strictObject({
  /** Relative to the target repository root. */
  path: z.string(),
  action: onboardingFileActionSchema,
});
export type OnboardingFileReport = z.infer<typeof onboardingFileReportSchema>;
