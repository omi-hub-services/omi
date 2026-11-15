/* global Buffer, process, __dirname */
// Windows entrypoint: node "\\wsl.localhost\<distro>\<project>\.omi-squad\bin\omi.cjs" <args>
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const distribution = "__OMI_DISTRO__";
const project = Buffer.from("__OMI_PROJECT_BASE64__", "base64").toString("utf8");
const args = process.argv.slice(2);
if (/^--omi-(?:runtime|node-version|worker-version)$/.test(args[0] ?? "")) {
  process.stderr.write("Internal launcher modes are not available from Windows.\n");
  process.exitCode = 2;
} else if (args[0] === "session" && args[1] === "start") {
  if (args.slice(2).some((arg) => /^--(?:distribution|project|runtime)(?:=|$)/.test(arg))) {
    process.stderr.write("The launcher owns the project and distribution binding.\n");
    process.exitCode = 2;
  } else {
    const cli = resolve(__dirname, "../tool/node_modules/omi-squad/dist/bootstrap/cli.js");
    process.argv = [
      process.execPath,
      cli,
      "session",
      "start",
      "--distribution",
      distribution,
      "--project",
      project,
      "--runtime",
      `${project}/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js`,
      ...args.slice(2),
    ];
    import(pathToFileURL(cli).href).catch(() => {
      process.stderr.write("Windows session launcher failed.\n");
      process.exitCode = 1;
    });
  }
} else {
  const result = spawnSync(
    "wsl.exe",
    [
      "--distribution",
      distribution,
      "--cd",
      project,
      "--exec",
      `${project}/.omi-squad/bin/omi`,
      ...args,
    ],
    { shell: false, stdio: "inherit", windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
}
