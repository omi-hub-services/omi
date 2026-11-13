/** Verified, extracted release held privately until the installation finishes. */
export interface ReleasePackage {
  prepare(version: string): Promise<{
    packageDir: string;
    changelog: string;
    cleanup(): Promise<void>;
  }>;
}
