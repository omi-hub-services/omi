// VIOLATION application-only-ports (type-only import still counts)
import type { fetchIssue } from "../../../infrastructure/github/github-issues.js";

export type IssueFetcher = typeof fetchIssue;
