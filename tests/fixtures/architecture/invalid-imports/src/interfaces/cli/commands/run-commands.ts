// VIOLATION interfaces-no-sql-github-spawn + interfaces-not-to-infrastructure
import { spawnSync } from "node:child_process";
import { fetchIssue } from "../../../infrastructure/github/github-issues.js";

export const runCommand = () => spawnSync("gh", ["issue", "view", fetchIssue(1)]);
