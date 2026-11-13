import { createRequire } from "node:module";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { assertSeparatePin } from "../../../../tools/coordinator/pin-policy.ts";
import { expect, it } from "vitest";

type Execute = (file: string, args: readonly string[]) => string;
type Bootstrap = (
  root: string,
  env: NodeJS.ProcessEnv,
  defaults: readonly string[],
  execute: Execute,
) => string;
const require = createRequire(import.meta.url);
function loadBootstrap(): Bootstrap {
  expect(existsSync("templates/prompts/coordinator-pin-guard.cjs")).toBe(true);
  return (
    require("../../../../templates/prompts/coordinator-pin-guard.cjs") as {
      runPinStatus: Bootstrap;
    }
  ).runPinStatus;
}

it.each(["host", "host-child", "ancestor", "host-alias", "wsl", "wsl-alias", "entry-alias"])(
  "never executes a rejected %s entry point",
  (kind) => {
    const run = loadBootstrap();
    const root = mkdtempSync(join(tmpdir(), "omi-pin-guard-"));
    try {
      const host = join(root, "host"),
        work = join(root, "work"),
        independent = join(root, "independent");
      for (const path of [host, work, independent]) mkdirSync(path);
      let selected =
        kind === "host" || kind === "host-alias"
          ? host
          : kind === "wsl" || kind === "wsl-alias"
            ? work
            : kind === "ancestor"
              ? root
              : kind === "host-child"
                ? join(host, "nested")
                : independent;
      const marker = join(root, "entry-executed");
      const entry = join(selected, "tools/coordinator/pin.ts");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(
        entry,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      );
      if (kind.endsWith("alias") && kind !== "entry-alias") {
        const alias = join(root, "alias");
        symlinkSync(selected, alias, "junction");
        selected = alias;
      }
      if (kind === "entry-alias") {
        const source = join(host, "pin.ts");
        writeFileSync(source, readFileSync(entry));
        rmSync(entry);
        symlinkSync(source, entry);
      }
      if (kind !== "entry-alias") {
        const canonical = realpathSync(selected);
        let policyRefused = false;
        try {
          assertSeparatePin(canonical, realpathSync(host));
          assertSeparatePin(canonical, realpathSync(work));
        } catch {
          policyRefused = true;
        }
        expect(policyRefused).toBe(true);
      }
      let calls = 0;
      const execute: Execute = (_file, args) => {
        calls++;
        runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
        return JSON.stringify({ initialized: true, checkout: selected });
      };
      expect(() =>
        run(
          host,
          { OMI_COORDINATOR_PIN_DIR: selected, OMI_WSL_REPO_DIR: work },
          ["pin", work, "Ubuntu"],
          execute,
        ),
      ).toThrow(/PIN_/);
      expect(calls).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("runs an isolated pin and refuses its attempt to redirect business commands into the worktree", () => {
  const run = loadBootstrap();
  const root = mkdtempSync(join(tmpdir(), "omi-pin-guard-"));
  try {
    const host = join(root, "host"),
      work = join(root, "work"),
      pin = join(root, "pin");
    for (const path of [host, work, join(pin, "tools/coordinator")])
      mkdirSync(path, { recursive: true });
    const marker = join(root, "executed");
    writeFileSync(
      join(pin, "tools/coordinator/pin.ts"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    let redirected = false;
    const execute: Execute = (_file, args) => {
      expect(args[1]).toBe("status");
      runInNewContext(readFileSync(args[0] ?? "", "utf8"), { require });
      return JSON.stringify({ initialized: true, checkout: redirected ? host : pin });
    };
    expect(() => {
      assertSeparatePin(pin, host);
    }).not.toThrow();
    expect(() => {
      assertSeparatePin(pin, work);
    }).not.toThrow();
    const env = { OMI_COORDINATOR_PIN_DIR: pin, OMI_WSL_REPO_DIR: work };
    expect(run(host, env, ["pin", work, "Ubuntu"], execute)).toBe(pin);
    expect(existsSync(marker)).toBe(true);
    redirected = true;
    expect(() => run(host, env, ["pin", work, "Ubuntu"], execute)).toThrow("PIN_STATUS_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
