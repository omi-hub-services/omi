import { describe, expect, it } from "vitest";
import { assertLifecycleApiCall } from "../../../live/github/lifecycle-api-guard.ts";

const repository = "omi-hub-services/omi-sandbox";
const base = `repos/${repository}`;
const workflow = "sandbox deploy.yml";

describe("live lifecycle API guard", () => {
  it.each([
    ["GET", "user"],
    ["GET", base],
    ["GET", `${base}/pulls/7/reviews`],
    ["GET", `${base}/actions/runs/7/pending_deployments`],
    ["GET", `${base}/branches/main/protection`],
    ["GET", `${base}/rulesets`],
    ["POST", `${base}/issues`],
    ["POST", `${base}/pulls`],
    ["POST", `${base}/git/refs`],
    ["POST", `${base}/releases`],
    ["POST", `${base}/issues/7/comments`],
    ["POST", `${base}/actions/workflows/sandbox%20deploy.yml/dispatches`],
    ["PATCH", `${base}/issues/7`],
    ["PUT", `${base}/pulls/7/merge`],
  ])("allows required harness call %s %s", (method, path) => {
    expect(() => {
      assertLifecycleApiCall({ method, path }, repository, workflow);
    }).not.toThrow();
  });

  it.each([
    ["POST", `${base}/pulls/7/reviews`],
    ["POST", `${base}/actions/runs/7/pending_deployments`],
    ["POST", `${base}/actions/workflows/other.yml/dispatches`],
    ["POST", `${base}/actions/workflows/sandbox deploy.yml/dispatches`],
    ["GET", "repos/other/repository/issues"],
    ["POST", "repos/other/repository/issues"],
    ["GET", `${base}-other/issues`],
    ["POST", `${base}-other/issues`],
    ["GET", "user/repos"],
    ["POST", `${base}/rulesets`],
    ["PUT", `${base}/rulesets/7`],
    ["PATCH", `${base}/rulesets/7`],
    ["POST", `${base}/branches/main/protection`],
    ["PUT", `${base}/branches/main/protection`],
    ["PATCH", `${base}/branches/main/protection`],
  ])("refuses unauthorized call %s %s", (method, path) => {
    expect(() => {
      assertLifecycleApiCall({ method, path }, repository, workflow);
    }).toThrow("sandbox guard refused API call");
  });

  it.each([
    "user",
    base,
    `${base}/issues/7`,
    `${base}/pulls/7/merge`,
    `${base}/git/refs`,
    `${base}/releases`,
    `${base}/rulesets/7`,
    "repos/other/repository/issues/7",
  ])("refuses DELETE even on otherwise allowed paths: %s", (path) => {
    expect(() => {
      assertLifecycleApiCall({ method: "DELETE", path }, repository, workflow);
    }).toThrow("sandbox guard refused API call");
  });
});
