import type { DeliveryPull, PrMapping } from "../contracts/pr-delivery.js";

export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  readonly code: string;
  constructor(code: string) {
    super(`PR delivery failed: ${code}`);
    this.code = code;
  }
}

/** Reads are complete and identity checked; unavailable/malformed data throws, never means absent.
 * Writes use GithubRemote through the durable outbox, not this reader. */
export interface PrDeliveryReader {
  issueBody(repository: string, number: number): Promise<string>;
  findOpenPull(repository: string, head: string, base: string): Promise<DeliveryPull | undefined>;
  pull(repository: string, number: number): Promise<DeliveryPull>;
  hasBacklink(repository: string, issueNumber: number, body: string, key: string): Promise<boolean>;
}

/** Both identities are written atomically; a different existing identity is refused. */
export interface PrMappingStore {
  get(projectId: string, taskId: string): PrMapping | undefined;
  save(mapping: PrMapping): void;
}
