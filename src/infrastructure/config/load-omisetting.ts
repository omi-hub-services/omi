import { join } from "node:path";
import { parseOmiSetting, type OmiSetting } from "../../application/contracts/omisetting.js";
import { readOptional } from "./package-content.js";

/** Never return JSON parser diagnostics: they may quote credential bytes. */
export async function loadOmiSetting(projectDir: string): Promise<OmiSetting | undefined> {
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
