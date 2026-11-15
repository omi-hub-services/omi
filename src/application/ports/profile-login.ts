/** Runs interactive native auth into one writable store; never returns auth material. */
export type ProfileLogin = (input: { projectDir?: string; profileId: string }) => Promise<void>;
