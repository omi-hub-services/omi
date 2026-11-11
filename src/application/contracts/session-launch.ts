import { z } from "zod";
function isLineSafe(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
export const wslPathSchema = z.string().startsWith("/").max(4096).refine(isLineSafe);
export const sessionLaunchSchema = z.strictObject({
  projectDir: wslPathSchema,
  runtimePath: wslPathSchema,
  distribution: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .optional(),
  coordinator: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.startsWith("-") && isLineSafe(value))
    .default("claude"),
});
export type SessionLaunchInput = z.infer<typeof sessionLaunchSchema>;
