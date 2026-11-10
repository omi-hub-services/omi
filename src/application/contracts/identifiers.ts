import { z } from "zod";

/** Run, attempt and similar runtime identifiers. */
export const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be 1-128 chars of A-Z a-z 0-9 . _ -");

/** Ids chosen by humans in YAML: steps, gates, roles, skills, rules, profiles, aliases. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be 1-64 chars of a-z 0-9 . _ -, starting alnum");

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha-256 hex");

export const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a lowercase 40-hex git sha");

// NUL is checked in code: a control character in a regex trips no-control-regex, and JSON
// Schema consumers do not need it (the wire is JSON text, validated again by the runtime).
function hasNoNul(value: string): boolean {
  return !value.includes(String.fromCharCode(0));
}

/** Relative POSIX path inside a workspace or run directory: no absolute path, no `..`, no `\`. */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?!\/)(?![A-Za-z]:)(?![\s\S]*(?:^|\/)\.\.(?:\/|$))[^\\\r\n\u2028\u2029]+$/u,
    "must be a relative path without '..' segments, drive prefix, backslashes or line breaks",
  )
  .refine(hasNoNul, "must not contain a NUL character");

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    /^\/(?![\s\S]*(?:^|\/)\.\.(?:\/|$))[^\\\r\n\u2028\u2029]*$/u,
    "must be an absolute path without '..', backslashes or line breaks",
  )
  .refine(hasNoNul, "must not contain a NUL character");
