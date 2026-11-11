import { describe, expect, it } from "vitest";
import { inspectProject } from "../../../src/application/use-cases/project/inspect-project.ts";
import { createGithubProjectReader } from "../../../src/infrastructure/github/github-project-reader.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createGhApiTransport } from "../../../src/infrastructure/github/gh-api-transport.ts";
import { TransportError } from "../../../src/infrastructure/github/github-transport.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";
import { project } from "../../fixtures/github/project-mapping.ts";
import { FakeGithubProjects } from "./fake-github-projects.ts";

function setup() {
  const fake = new FakeGithubProjects([
    project,
    {
      ...project,
      id: "PVT_user",
      number: 2,
      owner: { id: "MDQ6VXNlcjEyMzQ=", login: "pat", type: "User" },
    },
  ]);
  const sleeps: number[] = [];
  const client = createGithubRestClient({
    transport: fake,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
    random: () => 0,
  });
  return {
    fake,
    sleeps,
    client,
    reader: createGithubProjectReader(client),
    remote: createGithubRemote(client),
  };
}
const operation = {
  type: "project.copy" as const,
  ownerId: "O_sample",
  sourceProjectId: "PVT_sample",
  title: "App",
};

describe("Projects GraphQL contract (fake GitHub, no network)", () => {
  it.each([
    ["acme", 4, "Organization"],
    ["pat", 2, "User"],
  ] as const)(
    "discovers %s Project, every field page and option IDs",
    async (owner, number, ownerType) => {
      const h = setup();
      const result = await inspectProject(h.reader, { owner, number });
      expect(result.owner.type).toBe(ownerType);
      expect(result.fields).toEqual(project.fields);
      expect(h.fake.requests.map((r) => r.variables["after"])).toEqual([null, "1", "2"]);
      expect(await h.reader.owner(owner)).toEqual(result.owner);
    },
  );

  it("passes the query and variables to gh as stdin through the existing transport", async () => {
    const fake = new FakeGithubProjects([project]);
    const calls: string[][] = [];
    const transport = createGhApiTransport({
      run: async (args, stdin) => {
        calls.push([...args]);
        const response = await fake.send({
          method: "POST",
          path: "graphql",
          body: JSON.parse(stdin ?? "null") as unknown,
        });
        return {
          code: 0,
          timedOut: false,
          stdout: `HTTP/2.0 ${String(response.status)} OK\n\n${response.body}`,
        };
      },
    });
    const client = createGithubRestClient({
      transport,
      sleep: () => Promise.resolve(),
      now: () => 0,
      random: () => 0,
    });
    await createGithubProjectReader(client).inspect({ owner: "acme", number: 4 });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["api", "--include", "-X", "POST", "graphql", "--input", "-"]);
  });

  it("retries POST queries after transport timeout and HTTP rate-limit refusal", async () => {
    const h = setup();
    h.fake.nextResponse = new TransportError("timeout");
    await h.reader.owner("acme");
    expect(h.fake.requests).toHaveLength(2);
    h.fake.nextResponse = { status: 429, headers: { "retry-after": "1" }, body: "{}" };
    await h.reader.owner("pat");
    expect(h.sleeps).toContain(1000);
  });

  it.each([
    [{ data: { repositoryOwner: null } }, "PROJECT_NOT_FOUND"],
    [{ data: {}, errors: [{ message: "sensitive remote detail" }] }, "GRAPHQL_ERRORS"],
    [{ data: {} }, "INVALID_RESPONSE"],
    [{ errors: [{ type: "FORBIDDEN" }] }, "GRAPHQL_ERRORS"],
  ])("refuses unavailable/partial/malformed discovery", async (body, code) => {
    const h = setup();
    h.fake.nextResponse = { status: 200, headers: {}, body: JSON.stringify(body) };
    await expect(h.reader.inspect({ owner: "acme", number: 4 })).rejects.toMatchObject({ code });
  });

  it("refuses missing single-select options, repeated cursors and incomplete pagination", async () => {
    const h = setup();
    h.fake.nextResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: {
          repositoryOwner: {
            id: "O_sample",
            login: "acme",
            __typename: "Organization",
            projectV2: {
              id: "PVT_sample",
              number: 4,
              title: "App",
              fields: {
                nodes: [{ id: "PVTSSF_state", name: "State", dataType: "SINGLE_SELECT" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    };
    await expect(h.reader.inspect({ owner: "acme", number: 4 })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    h.fake.repeatCursor = true;
    await expect(h.reader.inspect({ owner: "acme", number: 4 })).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    h.fake.repeatCursor = false;
    await expect(
      createGithubProjectReader(h.client, 1).inspect({ owner: "acme", number: 4 }),
    ).rejects.toMatchObject({ code: "PAGINATION_LIMIT" });
  });

  it("copies a template with durable reconciliation marker and reads it back across pages", async () => {
    const h = setup();
    expect(await h.remote.send({ operation, operationKey: "init-app" })).toEqual({
      kind: "succeeded",
      remoteIdentity: "project:PVT_copy:9",
    });
    expect(h.fake.projects.at(-1)?.title).toBe(`App ${operationMarker("init-app")}`);
    expect(
      await h.remote.lookup({
        operation,
        operationKey: "init-app",
        notBefore: "2026-11-11T00:00:00.000Z",
      }),
    ).toEqual({ kind: "found", remoteIdentity: "project:PVT_copy:9" });
    expect(h.fake.projects.at(-1)?.fields[0]?.id).toBe("copy_PVTSSF_state");
  });

  it("does not retry a copy after timeout-after-success; readback finds it", async () => {
    const h = setup();
    h.fake.copyThenTimeout = true;
    expect(await h.remote.send({ operation, operationKey: "init-app" })).toMatchObject({
      kind: "outcome_unknown",
      code: "TIMEOUT",
    });
    expect(
      await h.remote.lookup({
        operation,
        operationKey: "init-app",
        notBefore: "2026-11-11T00:00:00.000Z",
      }),
    ).toMatchObject({ kind: "found" });
    expect(h.fake.requests.filter((r) => r.query.includes("copyProjectV2"))).toHaveLength(1);
  });

  it("refuses GraphQL mutation errors as unknown and incomplete lookup as unavailable", async () => {
    const h = setup();
    h.fake.nextResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({ errors: [{ type: "FORBIDDEN" }] }),
    };
    expect(await h.remote.send({ operation, operationKey: "init-app" })).toMatchObject({
      kind: "outcome_unknown",
    });
    h.fake.nextResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN" }] }),
    };
    expect(
      await h.remote.lookup({
        operation,
        operationKey: "init-app",
        notBefore: "2026-11-11T00:00:00.000Z",
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      await h.remote.lookup({
        operation,
        operationKey: "init-app",
        notBefore: "2026-11-11T00:00:00.000Z",
      }),
    ).toEqual({ kind: "absent" });
  });

  it("the read path refuses mutation text", () => {
    expect(() => setup().client.queryGraphql("mutation { copyProjectV2 }", {})).toThrow();
  });
});
