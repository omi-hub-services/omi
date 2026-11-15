export type ProjectDirectoryMigration = (projectDir: string) => Promise<{ directory: string }>;
