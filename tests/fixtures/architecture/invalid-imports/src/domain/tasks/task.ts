// VIOLATION domain-is-pure + domain-no-io-or-libraries
import { readFileSync } from "node:fs";
import { fetchIssue } from "../../infrastructure/github/github-issues.js";

export const loadTask = (path: string) => readFileSync(path, "utf8") + fetchIssue(1);
