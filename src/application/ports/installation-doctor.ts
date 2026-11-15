export interface InstallationDoctorCheck {
  name: string;
  ok: boolean;
  status: "pass" | "fail";
  detail: string;
  /** What the operator should do when the check fails (also given for a pass: how to re-check). */
  fix: string;
  /** Worker CLI checks only: compatibility.md classification. */
  classification?: "supported" | "untested" | "unsupported" | "not-installed";
}
export interface InstallationDoctorReport {
  /** Version of this report's JSON shape. */
  version: 1;
  distribution: string;
  checks: InstallationDoctorCheck[];
}
export type InstallationDoctor = (input: unknown) => Promise<InstallationDoctorReport>;
