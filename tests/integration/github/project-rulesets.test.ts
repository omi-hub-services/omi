import { createGithubRulesets } from "../../../src/infrastructure/github/github-rulesets.js";
import {
  configureGithubRulesets,
  type RulesetsMode,
} from "../../../src/application/use-cases/project/configure-github-rulesets.js";
import { expect, it } from "vitest";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.js";

it("exposes a read-only github rulesets preview", async () => {
  let output = "";
  const code = await runCli(["github", "rulesets", "--dry-run"], {
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
    sendCommand: () => Promise.reject(new Error("must not use runtime")),
    defaultSocketPath: "/tmp/unused",
    timeoutMs: 100,
    version: "test",
  });
  expect(output).not.toContain("unknown command");
  expect(code).toBe(2);
});

import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.js";
import type { HttpRequest } from "../../../src/infrastructure/github/github-transport.js";
import { projectConfigSchema } from "../../../src/application/contracts/project-config.js";
import { baseline } from "../../fixtures/github/project-mapping.js";

const config = projectConfigSchema.parse({
  ...baseline,
  branches: { integration: "integration", release: "stable" },
  checks: { ci: { command: ["npm", "test"] } },
});
function setup(
  options: { admin?: boolean; private?: boolean; plan?: string; planUnavailable?: boolean } = {},
) {
  const calls: HttpRequest[] = [];
  const stored: Record<string, unknown>[] = [];
  const client = createGithubRestClient({
    now: () => 0,
    random: () => 0,
    sleep: () => Promise.resolve(),
    transport: {
      send: (req) => {
        calls.push(req);
        let json: unknown;
        if (req.path.startsWith("orgs/"))
          json = options.planUnavailable === true ? {} : { plan: { name: options.plan ?? "team" } };
        else if (!req.path.includes("/rulesets"))
          json = {
            private: options.private ?? false,
            owner: { type: "Organization" },
            permissions: { admin: options.admin ?? true },
          };
        else if (req.method === "GET")
          json = /\/rulesets\/\d+$/.test(req.path)
            ? stored.find((r) => req.path.endsWith(`/${String(r["id"])}`))
            : stored;
        else {
          const body = req.body as Record<string, unknown>;
          const index = stored.findIndex((r) => r["name"] === body["name"]);
          const value = { ...body, id: index < 0 ? stored.length + 1 : stored[index]?.["id"] };
          if (index < 0) stored.push(value);
          else stored[index] = value;
          json = value;
        }
        return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(json) });
      },
    },
  });
  const port = createGithubRulesets(client);
  return {
    calls,
    stored,
    run: (mode: RulesetsMode) => configureGithubRulesets(port, config, mode),
  };
}
it("plans configured branches, applies them once, then makes no further writes", async () => {
  const f = setup();
  const preview = await f.run("dry-run");
  expect(preview.steps).toHaveLength(2);
  expect(preview.steps.map((s: { body: { conditions: unknown } }) => s.body.conditions)).toEqual([
    { ref_name: { include: ["refs/heads/stable"], exclude: [] } },
    { ref_name: { include: ["refs/heads/integration"], exclude: [] } },
  ]);
  expect(f.calls.every((r) => r.method === "GET")).toBe(true);
  expect((await f.run("apply")).ok).toBe(true);
  expect(f.stored).toHaveLength(2);
  const writes = f.calls.filter((r) => r.method !== "GET").length;
  expect((await f.run("apply")).steps).toEqual([]);
  expect(f.calls.filter((r) => r.method !== "GET")).toHaveLength(writes);
});
it("reports a weakened main approval and repairs only its ruleset", async () => {
  const f = setup();
  expect((await f.run("verify")).failures).toHaveLength(2);
  await f.run("apply");
  const main = f.stored[0];
  const rules = main?.["rules"] as { type: string; parameters?: Record<string, unknown> }[];
  const pr = rules.find((r) => r.type === "pull_request");
  if (pr?.parameters !== undefined) pr.parameters["required_approving_review_count"] = 0;
  const verified = await f.run("verify");
  expect(verified.ok).toBe(false);
  expect(verified.failures).toEqual(["effective rules on omi-main lack or weaken pull_request"]);
  expect((await f.run("apply")).steps).toHaveLength(1);
});
it.each([
  [{ admin: false }, "GITHUB_RULESETS_ADMIN_REQUIRED"],
  [{ private: true, plan: "free" }, "GITHUB_RULESETS_PRIVATE_FREE_ORG"],
])("refuses apply with a named error and no writes: %s", async (options, code) => {
  const f = setup(options);
  expect(await f.run("apply")).toMatchObject({ ok: false, code });
  expect(f.calls.every((r) => r.method === "GET")).toBe(true);
});

it("returns a nonzero CLI status and one line per missing ruleset on verify", async () => {
  const f = setup();
  let output = "";
  const code = await runCli(["github", "rulesets", "--verify"], {
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
    sendCommand: () => Promise.reject(new Error("must not use runtime")),
    defaultSocketPath: "/tmp/unused",
    timeoutMs: 100,
    version: "test",
    github: { rulesets: f.run },
  });
  expect(code).toBe(1);
  expect(output.trim().split("\n")).toEqual([
    "ruleset omi-main missing",
    "ruleset omi-develop missing",
  ]);
  expect(f.calls.every((r) => r.method === "GET")).toBe(true);
});
it("rejects conflicting CLI modes before accessing GitHub", async () => {
  const f = setup();
  const code = await runCli(["github", "rulesets", "--apply", "--verify"], {
    stdout: () => undefined,
    stderr: () => undefined,
    sendCommand: () => Promise.reject(new Error("must not use runtime")),
    defaultSocketPath: "/tmp/unused",
    timeoutMs: 100,
    version: "test",
    github: { rulesets: f.run },
  });
  expect(code).toBe(2);
  expect(f.calls).toEqual([]);
});

it("reports missing admin before trying to read a private organization plan", async () => {
  const f = setup({ admin: false, private: true, planUnavailable: true });
  expect(await f.run("apply")).toMatchObject({ code: "GITHUB_RULESETS_ADMIN_REQUIRED" });
  expect(f.calls).toHaveLength(1);
});
