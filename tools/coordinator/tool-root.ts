// Module-relative assets belong to the immutable tooling checkout, never the caller's cwd.
import { fileURLToPath } from "node:url";
export const COORDINATOR_TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
