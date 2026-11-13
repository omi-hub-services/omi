/* global process, console */
// Embedded verbatim in installed skills: only Node built-ins run before checkout isolation.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function runPinStatus(root, env, defaults, execute = execFileSync) {
  if (defaults.length !== 3 || defaults.some((value) => typeof value !== "string" || !value))
    throw new Error("PIN_DEFAULTS_INVALID");
  const host = fs.realpathSync(root);
  const requested = env.OMI_COORDINATOR_PIN_DIR ?? path.join(path.dirname(host), defaults[0]);
  if (!path.isAbsolute(requested)) throw new Error("PIN_PATH_MUST_BE_ABSOLUTE");
  const checkout = fs.realpathSync(requested);
  let work = env.OMI_WSL_REPO_DIR ?? defaults[1];
  if (process.platform === "win32" && work.startsWith("/")) {
    work = `\\\\wsl.localhost\\${env.OMI_WSL_DISTRO ?? defaults[2]}${work.replaceAll("/", "\\")}`;
  }
  if (!path.isAbsolute(work)) throw new Error("PIN_WORK_PATH_MUST_BE_ABSOLUTE");
  const targets = [host, fs.realpathSync(work)];
  for (const target of targets) {
    if (contains(checkout, target) || contains(target, checkout))
      throw new Error("PIN_CHECKOUT_OVERLAPS_WORKTREE");
  }
  const entry = fs.realpathSync(path.join(checkout, "tools/coordinator/pin.ts"));
  if (!contains(checkout, entry)) throw new Error("PIN_ENTRYPOINT_OUTSIDE_CHECKOUT");
  for (const target of targets) {
    if (contains(target, entry)) throw new Error("PIN_ENTRYPOINT_OVERLAPS_WORKTREE");
  }
  let status;
  try {
    status = JSON.parse(
      execute(process.execPath, [entry, "status"], {
        cwd: host,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: { ...env, OMI_COORDINATOR_PIN_DIR: checkout },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw new Error("PIN_STATUS_FAILED");
  }
  // Never let a selected entry point redirect the already validated business-command path.
  if (
    status === null ||
    typeof status !== "object" ||
    status.initialized !== true ||
    typeof status.checkout !== "string"
  )
    throw new Error("PIN_STATUS_INVALID");
  if (path.relative(checkout, fs.realpathSync(status.checkout)) !== "")
    throw new Error("PIN_STATUS_INVALID");
  return checkout;
}
module.exports = { runPinStatus };

if (require.main === module || process.argv[1] === "-") {
  try {
    process.stdout.write(runPinStatus(process.cwd(), process.env, process.argv.slice(2)));
  } catch (error) {
    console.error(`pin bootstrap: refused: ${error.message}`);
    process.exitCode = 1;
  }
}
