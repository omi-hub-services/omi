/* global Buffer, process, __dirname */
// Windows entrypoint: node "\\wsl.localhost\<distro>\<project>\.omi\bin\omi.cjs" <args>
const { spawnSync } = require("node:child_process");
const { existsSync, lstatSync, readFileSync } = require("node:fs");
const { basename, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const distribution = "__OMI_DISTRO__";
const project = Buffer.from("__OMI_PROJECT_BASE64__", "base64").toString("utf8");
const args = process.argv.slice(2);
class SettingsError extends Error {}
function invalid(path) {
  throw new SettingsError(`${path || "settings"}: invalid or missing value`);
}

// Validate only the subset emitted by our packaged schema; unknown keywords fail closed.
function validateNode(value, schema, path, depth = 0) {
  if (depth > 64) invalid(path);
  const supported = [
    "$schema",
    "$comment",
    "description",
    "type",
    "const",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "oneOf",
    "pattern",
    "format",
    "minLength",
    "minItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
  ];
  if (Object.keys(schema).some((key) => !supported.includes(key))) invalid(path);
  if (schema.oneOf) {
    const branch = schema.oneOf.find((entry) => entry.properties?.tool?.const === value?.tool);
    if (!branch) invalid(`${path}.tool`);
    validateNode(value, branch, path, depth + 1);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) invalid(path);
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path);
    for (const key of schema.required ?? [])
      if (!(key in value)) invalid(path ? `${path}.${key}` : key);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) invalid(path);
      validateNode(value[key], schema.properties[key], path ? `${path}.${key}` : key, depth + 1);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)) invalid(path);
    value.forEach((entry, index) =>
      validateNode(entry, schema.items, `${path}[${index}]`, depth + 1),
    );
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0)) invalid(path);
    // JSON Schema export omits the contract's case-insensitive memory-unit flag.
    if (
      schema.pattern &&
      !new RegExp(schema.pattern, path === "docker.memory" ? "i" : "").test(value)
    )
      invalid(path);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum) ||
      (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
    )
      invalid(path);
  } else invalid(path);
}
function validateSettings(value, schema) {
  validateNode(value, schema, "");
  const ids = new Set();
  value.profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) invalid(`profiles[${index}].id`);
    ids.add(profile.id);
  });
  return value;
}
function readSettings(root, packageRoot) {
  const path = resolve(root, ".omi/omisetting.local.json");
  if (!existsSync(path)) return undefined;
  let value;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) invalid("settings");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    invalid("settings");
  }
  return validateSettings(value, require(resolve(packageRoot, "schemas/omisetting.schema.json")));
}
function dockerEnvironment(settings, includeProfiles) {
  const env = { GH_TOKEN: settings.github.token };
  if (includeProfiles) {
    const metadata = {
      ...settings,
      github: { ...settings.github, token: "" },
      profiles: settings.profiles.map((profile, index) => {
        if (profile.auth.type !== "token") return profile;
        env[`OMI_DOCKER_PROFILE_TOKEN_${index}`] = profile.auth.token;
        return { ...profile, auth: { type: "token", token: "" } };
      }),
    };
    env.OMI_DOCKER_SETTINGS = JSON.stringify(metadata);
  }
  return env;
}
async function main() {
  const root = resolve(__dirname, "../..");
  const packageRoot = resolve(__dirname, "../tool/node_modules/omi-squad");
  const settings = readSettings(root, packageRoot);
  if (settings?.docker === undefined) return legacy();
  if (/^--omi-(?:runtime|node-version|worker-version)$/.test(args[0] ?? ""))
    throw new Error("Internal mode refused");
  const repo = basename(root);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repo)) invalid("project");
  const target = {
    container: settings.docker.container ?? `omi-${repo}`,
    repoDir: `/work/${repo}`,
  };
  if (
    args[0] === "docker" ||
    args[0] === "doctor" ||
    (args[0] === "profile" && args[1] === "login") ||
    (args[0] === "session" && args[1] === "start")
  ) {
    process.chdir(root);
    const cli = resolve(packageRoot, "dist/bootstrap/cli.js");
    if (args[0] === "session" && args[1] === "start") {
      if (args.slice(2).some((arg) => /^--(?:distribution|project|runtime)(?:=|$)/.test(arg)))
        throw new Error("Launcher binding refused");
      process.argv = [
        process.execPath,
        cli,
        "session",
        "start",
        "--project",
        target.repoDir,
        "--runtime",
        `${target.repoDir}/.omi/tool/node_modules/omi-squad/dist/bootstrap/runtime.js`,
        ...args.slice(2),
      ];
    } else process.argv = [process.execPath, cli, ...args];
    await import(pathToFileURL(cli).href);
    return;
  }
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "GH_TOKEN",
      "-w",
      target.repoDir,
      target.container,
      `${target.repoDir}/.omi/bin/omi`,
      ...args,
    ],
    {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...dockerEnvironment(settings, false) },
    },
  );
  process.exitCode = result.status ?? 1;
}
function legacy() {
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
        `${project}/.omi/tool/node_modules/omi-squad/dist/bootstrap/runtime.js`,
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
        `${project}/.omi/bin/omi`,
        ...args,
      ],
      { shell: false, stdio: "inherit", windowsHide: true },
    );
    process.exitCode = result.status ?? 1;
  }
}
module.exports = { main, validateSettings, dockerEnvironment };
if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      error instanceof SettingsError
        ? `${error.message}\n`
        : "Project launcher failed; check settings and Docker.\n",
    );
    process.exitCode = 1;
  });
