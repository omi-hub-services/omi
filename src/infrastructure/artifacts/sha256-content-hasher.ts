import { createHash } from "node:crypto";
import type { ContentHasher } from "../../application/ports/content-hasher.js";

export const sha256ContentHasher: ContentHasher = {
  sha256: (content) => createHash("sha256").update(content, "utf8").digest("hex"),
};
