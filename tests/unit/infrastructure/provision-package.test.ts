import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { executable: string; args: readonly string[] }[] = [];
vi.mock("../../../src/infrastructure/processes/run-command.js", () => ({
  runCommand: (options: { executable: string; args: readonly string[] }) => {
    calls.push({ executable: options.executable, args: options.args });
    return Promise.resolve({
      kind: "finished",
      exit: { exitCode: 0 },
      stdout: JSON.stringify([{ filename: "omi-squad-0.0.0.tgz" }]),
    });
  },
}));

const { provisionPackage } =
  await import("../../../src/infrastructure/config/install-project-package.js");

const realPlatform = process.platform;
let dir: string;
beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(join(tmpdir(), "omi-provision-"));
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  await rm(dir, { recursive: true, force: true });
});

describe("provisionPackage npm invocation", () => {
  it("runs npm through node and npm-cli.js on a win32 host, never a bare npm or .cmd", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    await provisionPackage("/pkg", join(dir, "tool"));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.executable).toBe(process.execPath);
      expect(call.args[0]).toBe(
        join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      );
    }
    expect(calls[0]?.args[1]).toBe("pack");
    expect(calls[1]?.args[1]).toBe("install");
  });

  it("keeps plain npm on POSIX", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await provisionPackage("/pkg", join(dir, "tool"));
    expect(calls.map((call) => call.executable)).toEqual(["npm", "npm"]);
    expect(calls[1]?.args[0]).toBe("install");
  });

  it("skips lifecycle scripts for a Docker project host install only", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await provisionPackage("/pkg", join(dir, "tool"), { docker: true });
    expect(calls[1]?.args).toContain("--ignore-scripts");
    calls.length = 0;
    await provisionPackage("/pkg", join(dir, "tool"));
    expect(calls[1]?.args).not.toContain("--ignore-scripts");
  });
});
