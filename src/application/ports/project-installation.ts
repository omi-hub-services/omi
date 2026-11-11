import type {
  FrameworkLock,
  InstallationInput,
  TemplateFiles,
} from "../contracts/project-installation.js";

export interface InstallationSnapshot {
  candidate: FrameworkLock;
  installed: FrameworkLock | undefined;
  local: TemplateFiles;
}
export interface InstallationPlan extends InstallationSnapshot {
  input: InstallationInput;
  merged: TemplateFiles;
}
export interface ProjectInstallation {
  inspect(input: InstallationInput): Promise<InstallationSnapshot>;
  apply(plan: InstallationPlan): Promise<{ backupDir: string }>;
}
