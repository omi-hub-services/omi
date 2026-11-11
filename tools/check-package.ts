// npm's real archive listing is the authority, not a separate guessed file list.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

interface PackedFile {
  path: string;
}
export function validatePackedFiles(files: readonly PackedFile[]): void {
  const required = ["dist/", "templates/", "schemas/", "migrations/"];
  for (const { path } of files) {
    if (
      !/^(dist|templates|schemas|migrations)\//.test(path) &&
      !/^(package\.json|README(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?)$/i.test(path)
    )
      throw new Error(`Unexpected package file: ${path}`);
    if (
      path
        .split("/")
        .some(
          (part) =>
            part === ".." ||
            /^\.env(?:\.|$)/.test(part) ||
            /^(?:auth|credentials)\.json$/.test(part) ||
            part === "node_modules" ||
            part === "local",
        ) ||
      /\.(sqlite(?:-wal|-shm)?|log|pem|key)$/.test(path)
    )
      throw new Error(`Forbidden package content: ${path}`);
  }
  for (const prefix of required)
    if (!files.some((file) => file.path.startsWith(prefix)))
      throw new Error(`Missing package directory: ${prefix}`);
  if (!files.some((file) => file.path === "dist/bootstrap/cli.js"))
    throw new Error("Missing executable");
}
export function packAndCheck(root: string, destination: string): string {
  const parsed: unknown = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--cache",
        join(destination, "npm-cache"),
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        destination,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Invalid npm pack output");
  const entry: unknown = parsed[0];
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("filename" in entry) ||
    typeof entry.filename !== "string" ||
    !("files" in entry) ||
    !Array.isArray(entry.files)
  )
    throw new Error("Invalid npm pack metadata");
  const files: PackedFile[] = entry.files.map((file: unknown) => {
    if (
      typeof file !== "object" ||
      file === null ||
      !("path" in file) ||
      typeof file.path !== "string"
    )
      throw new Error("Invalid npm pack file");
    return { path: file.path };
  });
  validatePackedFiles(files);
  return join(destination, entry.filename);
}
if (import.meta.main) {
  const root = resolve(".");
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temp = mkdtempSync(join(root, ".tmp", "pack-"));
  try {
    packAndCheck(root, temp);
    console.log(
      "pack:check: clean archive (dist/templates/schemas/migrations and npm metadata only)",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
