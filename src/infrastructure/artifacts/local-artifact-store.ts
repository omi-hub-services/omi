import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import {
  artifactReferenceSchema,
  artifactWriteSchema,
} from "../../application/contracts/artifact.js";
import { ArtifactError, type ArtifactStore } from "../../application/ports/artifact-store.js";
import {
  assertCredentialFree,
  type CredentialPolicy,
} from "../../application/contracts/credential-input.js";
import type { StateDatabase } from "../persistence/sqlite/sqlite-connection.js";
import { runInTransaction } from "../persistence/sqlite/sqlite-transaction.js";
import {
  hasFsCode,
  resolveArtifactPath,
  syncDirectory,
  validateArtifactPath,
} from "./artifact-path.js";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function guardBytes(bytes: Uint8Array, policy: CredentialPolicy): void {
  const text = new TextDecoder().decode(bytes);
  assertCredentialFree(text, policy);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  assertCredentialFree(data, policy);
}

/**
 * The root must already exist; bootstrap owns its location/lifecycle. A synchronous SQLite
 * transaction serializes cooperating publications; bulk file I/O happens before it. Linking
 * the synced temp publishes without overwriting even outside writers. No row is inserted until
 * the temp is unlinked and the directory synced. Failed publications roll back only their
 * own inode. Cleanup is best effort and never masks the publication error; a killed writer
 * or a filesystem refusing cleanup can still leave unreferenced files for recovery.
 */
export function createLocalArtifactStore(
  root: string,
  db: StateDatabase,
  policy: CredentialPolicy = {},
): ArtifactStore {
  assertCredentialFree(root, policy);
  if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new ArtifactError("INVALID_PATH");
  }
  const canonicalRoot = fs.realpathSync(root);
  const lookup = db.prepare("SELECT content_hash FROM artifacts WHERE relative_path = ?");
  const exists = db.prepare("SELECT 1 FROM artifacts WHERE id = ? OR relative_path = ?");
  const insert = db.prepare(
    `INSERT INTO artifacts (id, relative_path, content_hash, producer_attempt_id, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const store: ArtifactStore = {
    write(input) {
      validateArtifactPath(input.path);
      const { bytes: suppliedBytes, ...metadata } = artifactWriteSchema.parse(input);
      assertCredentialFree(metadata, policy);
      // Snapshot mutable caller buffers: hashing and writing must observe exactly the same bytes.
      const bytes = Buffer.from(suppliedBytes);
      guardBytes(bytes, policy);
      const sha256 = hash(bytes);
      const target = resolveArtifactPath(canonicalRoot, metadata.path, true);
      const directory = dirname(target);
      const temp = join(directory, `.artifact-${randomUUID()}.tmp`);
      let fd: number | undefined;
      let ownsTemp = false;
      const publication: { stat?: fs.BigIntStats } = {};
      try {
        fd = fs.openSync(temp, "wx", 0o600);
        ownsTemp = true;
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        const tempStat = fs.fstatSync(fd, { bigint: true });
        fs.closeSync(fd);
        fd = undefined;
        return runInTransaction(db, () => {
          if (exists.get(metadata.id, metadata.path) !== undefined) {
            throw new ArtifactError("ALREADY_EXISTS");
          }
          try {
            fs.linkSync(temp, target);
            publication.stat = tempStat;
          } catch (error) {
            if (hasFsCode(error, "EEXIST")) throw new ArtifactError("ALREADY_EXISTS");
            if (
              ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].some((code) =>
                hasFsCode(error, code),
              )
            ) {
              throw new ArtifactError("HARD_LINK_UNSUPPORTED");
            }
            throw error;
          }
          fs.unlinkSync(temp);
          ownsTemp = false;
          syncDirectory(directory);
          insert.run(
            metadata.id,
            metadata.path,
            sha256,
            metadata.producerAttemptId ?? null,
            metadata.classification,
            metadata.createdAt,
          );
          return { path: metadata.path, sha256 };
        });
      } catch (error) {
        // A failed INSERT/COMMIT or temp unlink must not strand our published inode. An
        // outside writer may have replaced the target: never remove a different file/link.
        const publishedStat = publication.stat;
        if (publishedStat !== undefined) {
          try {
            const targetStat = fs.lstatSync(target, { bigint: true });
            if (
              targetStat.isFile() &&
              targetStat.dev === publishedStat.dev &&
              targetStat.ino === publishedStat.ino
            ) {
              fs.unlinkSync(target);
              syncDirectory(directory);
            }
          } catch {
            // Preserve the original error even when rollback itself cannot finish.
          }
        }
        throw error;
      } finally {
        try {
          if (fd !== undefined) fs.closeSync(fd);
        } catch {
          // A secondary close failure must not replace the publication error.
        }
        try {
          if (ownsTemp) fs.unlinkSync(temp);
        } catch {
          // In particular, retrying a failed temp unlink must not mask its first error.
        }
      }
    },

    read(reference) {
      validateArtifactPath(reference.path);
      const pinned = artifactReferenceSchema.parse(reference);
      assertCredentialFree(pinned, policy);
      const target = resolveArtifactPath(canonicalRoot, pinned.path, false);
      const row = lookup.get(pinned.path) as { content_hash: string } | undefined;
      if (row === undefined) throw new ArtifactError("NOT_FOUND");
      let bytes: Buffer;
      let fd: number | undefined;
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (!fs.fstatSync(fd).isFile()) throw new ArtifactError("INVALID_PATH");
        bytes = fs.readFileSync(fd);
      } catch (error) {
        if (hasFsCode(error, "ENOENT")) throw new ArtifactError("NOT_FOUND");
        if (hasFsCode(error, "ELOOP")) throw new ArtifactError("INVALID_PATH");
        throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      if (row.content_hash !== pinned.sha256 || hash(bytes) !== pinned.sha256) {
        throw new ArtifactError("HASH_MISMATCH");
      }
      guardBytes(bytes, policy);
      return bytes;
    },

    manifest(references) {
      return {
        schemaVersion: 1,
        artifacts: references.map((reference) => {
          const bytes = store.read(reference);
          return { path: reference.path, sha256: reference.sha256, size: bytes.byteLength };
        }),
      };
    },
  };
  return store;
}
