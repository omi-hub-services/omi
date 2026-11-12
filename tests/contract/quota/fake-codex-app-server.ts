// A stand-in `codex app-server`: JSON-RPC lines over stdio. It answers from fixture data and
// records what it was asked. No real CLI, login, network or model quota.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function quotaFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../fixtures/quota", name), "utf8"),
  ) as unknown;
}

export interface FakeAppServerScenario {
  /** `result` of `account/rateLimits/read`. */
  result?: unknown;
  behaviour?: "reply" | "rpc-error" | "exit-before-result" | "hang";
}

export interface AppServerInvocation {
  argv: string[];
  codexHome: string | undefined;
  envKeys: string[];
  methods: string[];
}

export function writeFakeAppServer(
  dir: string,
  name: string,
  scenario: FakeAppServerScenario,
  recordPath: string,
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const record = { argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME, envKeys: Object.keys(process.env).sort(), methods: [] };
const save = () => appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record) + "\n");
const behaviour = scenario.behaviour ?? "reply";
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const message = JSON.parse(line);
    record.methods.push(message.method);
    save();
    if (message.method === "initialize") reply({ id: message.id, result: {} });
    if (message.method === "account/rateLimits/read") {
      if (behaviour === "hang") return;
      if (behaviour === "exit-before-result") process.exit(0);
      if (behaviour === "rpc-error") reply({ id: message.id, error: { code: -1, message: "denied" } });
      else reply({ id: message.id, result: scenario.result });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

export function readAppServerInvocations(recordPath: string): AppServerInvocation[] {
  let text: string;
  try {
    text = readFileSync(recordPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AppServerInvocation);
}
