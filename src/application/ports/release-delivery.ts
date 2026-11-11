import type { MergedPull } from "../../domain/delivery/release-policy.js";

/** Complete, identity-checked reads; unavailable or malformed data throws, never means empty. */
export interface ReleaseReader {
  /** Merge time of the latest merged `develop` → `main` PR; undefined when none exists. */
  lastReleaseMergedAt(repository: string): Promise<string | undefined>;
  /** Every PR merged into `develop`. */
  mergedDevelopPulls(repository: string): Promise<MergedPull[]>;
}
