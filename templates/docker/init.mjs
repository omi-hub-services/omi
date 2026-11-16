import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw new Error("Invalid initialization input");
}
const config = JSON.parse(input);
if (
  !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.repo) ||
  !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(config.url) ||
  typeof config.gitUser?.name !== "string" ||
  typeof config.gitUser?.email !== "string" ||
  typeof config.branch !== "string" ||
  !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(config.branch) ||
  /\.\.|\/\/|[./]$|\.lock(\/|$)/.test(config.branch)
)
  throw new Error("Invalid initialization input");
const directory = `${process.env.OMI_WORK_ROOT ?? "/work"}/${config.repo}`;
const helper = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
function run(args) {
  return spawnSync("git", args, {
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
function git(args) {
  if (run(args).status !== 0) throw new Error("Repository initialization failed");
}
if (!existsSync(`${directory}/.git`)) {
  git([...helper, "clone", "--", config.url, directory]);
  if (run(["-C", directory, "checkout", config.branch]).status !== 0)
    fail(`Integration branch ${config.branch} is not available in the container checkout.`);
}
git(["-C", directory, "config", "user.name", config.gitUser.name]);
git(["-C", directory, "config", "user.email", config.gitUser.email]);

git(["-C", directory, "config", "credential.helper", "!gh auth git-credential"]);

// Never reset: only a clean checkout already on the integration branch is fast-forwarded.
if (run(["-C", directory, ...helper, "fetch", "origin", config.branch]).status !== 0)
  fail(`Cannot fetch integration branch ${config.branch}.`);
const current = run(["-C", directory, "branch", "--show-current"]).stdout.trim();
const status = run(["-C", directory, "status", "--porcelain"]);
if (current !== config.branch || status.status !== 0 || status.stdout.trim() !== "")
  fail(
    `Container checkout is not a clean ${config.branch}; resolve it manually. Nothing was changed.`,
  );
if (run(["-C", directory, "merge", "--ff-only", "FETCH_HEAD"]).status !== 0)
  fail(
    `Container branch ${config.branch} has diverged from origin; resolve it manually. Nothing was changed.`,
  );

// The runtime lives in the container checkout (.omi/tool/node_modules is gitignored): install it
// when missing or when package-lock.json changed since the last successful install.
const tool = `${directory}/.omi/tool`;
if (!existsSync(`${tool}/package.json`))
  fail("The project runtime is not installed on this branch: .omi/tool/package.json is missing.");
if (!existsSync(`${tool}/package-lock.json`))
  fail("The project runtime cannot be installed: .omi/tool/package-lock.json is missing.");
const lockHash = createHash("sha256")
  .update(readFileSync(`${tool}/package-lock.json`))
  .digest("hex");
const marker = `${tool}/node_modules/.omi-lock-hash`;
const installed = existsSync(marker) && readFileSync(marker, "utf8").trim() === lockHash;
if (!installed) {
  const npm = spawnSync(process.env.OMI_NPM ?? "npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: tool,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (npm.status !== 0) fail("npm ci failed in .omi/tool; the project runtime is not installed.");
  writeFileSync(marker, `${lockHash}\n`);
}
