// Executable entrypoint of the CLI: reads the process environment, wires, runs, sets the exit code.
import { runCli } from "../interfaces/cli/commands/create-program.js";
import { createCliEnvironment, defaultSocketPath } from "./container.js";

const socketPath = process.env["OMI_SQUAD_SOCKET"] ?? defaultSocketPath(process.cwd());

process.exitCode = await runCli(
  process.argv.slice(2),
  createCliEnvironment({
    socketPath,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
);
