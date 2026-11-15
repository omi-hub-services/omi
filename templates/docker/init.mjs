import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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
  typeof config.gitUser?.email !== "string"
)
  throw new Error("Invalid initialization input");
const directory = `/work/${config.repo}`;
function git(args) {
  const result = spawnSync("git", args, { shell: false, stdio: "ignore" });
  if (result.status !== 0) throw new Error("Repository initialization failed");
}
if (!existsSync(`${directory}/.git`))
  git([
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "clone",
    "--",
    config.url,
    directory,
  ]);
git(["-C", directory, "config", "user.name", config.gitUser.name]);
git(["-C", directory, "config", "user.email", config.gitUser.email]);

git(["-C", directory, "config", "credential.helper", "!gh auth git-credential"]);
