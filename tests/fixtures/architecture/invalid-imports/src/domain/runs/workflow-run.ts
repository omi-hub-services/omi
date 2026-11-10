// VIOLATION no-circular (workflow-run <-> step-run)
import { stepCount } from "./step-run.js";

export const runName = () => `run-${String(stepCount())}`;
