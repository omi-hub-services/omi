import type { InstallationDoctor } from "../../ports/installation-doctor.js";
export async function inspectInstallation(probe: InstallationDoctor, input: unknown) {
  const report = await probe(input);
  return { ...report, supported: report.checks.every((check) => check.ok) };
}
