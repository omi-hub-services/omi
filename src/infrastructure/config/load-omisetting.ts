import { join } from "node:path";
import { parseOmiSetting, type OmiSetting } from "../../application/contracts/omisetting.js";
import { readOptional } from "./package-content.js";

/** Never return JSON parser diagnostics: they may quote credential bytes. */
export async function loadOmiSetting(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmiSetting | undefined> {
  if (env.OMI_DOCKER_RUNTIME === "1") return readDockerRuntimeSettings(env);
  let text: string | undefined;
  try {
    text = await readOptional(join(projectDir, ".omi", "omisetting.local.json"));
  } catch {
    throw new Error("omisetting.local.json: cannot read a regular settings file");
  }
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("omisetting.local.json: invalid JSON");
  }
  return parseOmiSetting(value);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${path}: invalid runtime metadata`);
  return value as Record<string, unknown>;
}

/** Docker settings exist only in memory; token bytes never enter metadata. */
function readDockerRuntimeSettings(env: NodeJS.ProcessEnv): OmiSetting {
  const text = env.OMI_DOCKER_SETTINGS;
  if (text === undefined || text.length > 1048576)
    throw new Error("settings: missing runtime metadata");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("settings: invalid runtime metadata");
  }
  const metadata = object(raw, "settings");
  const github = object(metadata.github, "github");
  if (github.token !== "") throw new Error("github.token: runtime metadata must use a placeholder");
  if (!Array.isArray(metadata.profiles)) throw new Error("profiles: invalid runtime metadata");
  const profiles = metadata.profiles.map((value: unknown, index) => {
    const entry = object(value, `profiles[${String(index)}]`);
    const auth = object(entry.auth, `profiles[${String(index)}].auth`);
    if (auth.type !== "token") return entry;
    if (auth.token !== "")
      throw new Error(
        `profiles[${String(index)}].auth.token: runtime metadata must use a placeholder`,
      );
    return { ...entry, auth: { ...auth, token: env[`OMI_DOCKER_PROFILE_TOKEN_${String(index)}`] } };
  });
  return parseOmiSetting({ ...metadata, github: { ...github, token: env.GH_TOKEN }, profiles });
}
