export interface InstallationDoctorReport {
  distribution: string;
  checks: { name: string; ok: boolean; detail: string }[];
}
export type InstallationDoctor = (input: unknown) => Promise<InstallationDoctorReport>;
