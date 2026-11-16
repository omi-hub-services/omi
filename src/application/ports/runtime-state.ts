/** The read-only views were asked for before the runtime created its state database. */
export class NoRuntimeStateError extends Error {
  override readonly name = "NoRuntimeStateError";
  readonly code = "NO_RUNTIME_STATE";
  constructor() {
    super("no runtime state yet; run `omi session start` first");
  }
}
