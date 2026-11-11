/** SHA-256 of UTF-8 text, returned as lowercase hex. */
export interface ContentHasher {
  sha256(content: string): string;
}
