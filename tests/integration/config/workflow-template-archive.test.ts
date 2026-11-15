import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowCatalog } from "../../../src/infrastructure/config/load-workflow-catalog.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const original = readFileSync(
  resolve("tests/fixtures/workflow-archive/feature-with-qa.yaml"),
  "utf8",
);
const updated = readFileSync(resolve("templates/project/workflows/feature.yaml"), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function project() {
  const squad = mkdtempSync(join(tmpdir(), "omi-archive-"));
  dirs.push(squad);
  mkdirSync(join(squad, "workflows"), { recursive: true });
  const local = join(squad, "local");
  const install = (text: string) => {
    writeFileSync(join(squad, "workflows", "feature.yaml"), text);
  };
  const load = (persist = true) =>
    loadWorkflowCatalog(join(squad, "workflows"), ["feature"], { localDir: local, persist });
  return { squad, local, install, load };
}

describe("pinned workflow template archive", () => {
  it("keeps resolving the template a run pinned after an update replaces the installed file", async () => {
    const p = project();
    p.install(original);
    await p.load(); // the runtime starts, so a run planned now pins sha(original)
    p.install(updated);
    const catalog = await p.load();
    expect(catalog.byHash(sha(original))?.hash).toBe(sha(original));
    expect(catalog.byHash(sha(updated))?.hash).toBe(sha(updated));
    expect(catalog.byId("feature")?.hash).toBe(sha(updated));
    expect(catalog.byHash(sha(original))?.workflow.steps.map((step) => step.id)).toContain(
      "verify",
    );
    expect(catalog.byId("feature")?.workflow.steps.map((step) => step.id)).not.toContain("verify");
  });

  it("keeps resolving reproduce/implement for a bugfix run pinned before the single fix step", async () => {
    const oldBugfix = readFileSync(
      resolve("tests/fixtures/workflow-archive/bugfix-reproduce-implement.yaml"),
      "utf8",
    );
    const current = readFileSync(resolve("templates/project/workflows/bugfix.yaml"), "utf8");
    const squad = mkdtempSync(join(tmpdir(), "omi-archive-"));
    dirs.push(squad);
    mkdirSync(join(squad, "workflows"), { recursive: true });
    const load = () =>
      loadWorkflowCatalog(join(squad, "workflows"), ["bugfix"], {
        localDir: join(squad, "local"),
        persist: true,
      });
    writeFileSync(join(squad, "workflows", "bugfix.yaml"), oldBugfix);
    await load(); // a run planned now pins sha(oldBugfix)
    writeFileSync(join(squad, "workflows", "bugfix.yaml"), current);
    const catalog = await load();
    const ids = (hash: string) => catalog.byHash(hash)?.workflow.steps.map((step) => step.id);
    expect(ids(sha(oldBugfix))).toEqual(["reproduce", "implement", "review"]);
    expect(ids(sha(current))).toEqual(["fix", "review"]);
    expect(catalog.byId("bugfix")?.hash).toBe(sha(current));
  });

  it("loads the template of a run planned before the archive existed from an install backup", async () => {
    const p = project();
    p.install(updated);
    const backup = join(p.local, "backups", "install-1");
    mkdirSync(backup, { recursive: true });
    writeFileSync(
      join(backup, "templates.json"),
      JSON.stringify({ "workflows/feature.yaml": original, "config/models.yaml": "x" }),
    );
    const catalog = await p.load();
    expect(catalog.byHash(sha(original))?.hash).toBe(sha(original));
  });

  it("does not write the archive from a read-only observer", async () => {
    const p = project();
    p.install(original);
    await p.load(false);
    expect(existsSync(join(p.local, "workflow-archive"))).toBe(false);
  });

  it("ignores an archive entry whose bytes do not match the hash it is stored under", async () => {
    const p = project();
    p.install(updated);
    const archive = join(p.local, "workflow-archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, `${sha(original)}.yaml`), `${original}# tampered\n`);
    const catalog = await p.load();
    expect(catalog.byHash(sha(original))).toBeUndefined();
  });

  it("ignores a backup entry that is not a valid workflow", async () => {
    const p = project();
    p.install(updated);
    const backup = join(p.local, "backups", "install-1");
    mkdirSync(backup, { recursive: true });
    writeFileSync(
      join(backup, "templates.json"),
      JSON.stringify({ "workflows/feature.yaml": "not: a workflow\n" }),
    );
    const catalog = await p.load();
    expect(catalog.byHash(sha("not: a workflow\n"))).toBeUndefined();
  });
});

it.each(["idea-to-issues", "docs", "ci-cd", "ui-ux"])(
  "resolves old %s bytes and graph after updating",
  async (id) => {
    const old = readFileSync(`tests/fixtures/workflow-archive/${id}-small-steps.yaml`, "utf8");
    const current = readFileSync(`templates/project/workflows/${id}.yaml`, "utf8");
    const squad = mkdtempSync(join(tmpdir(), "omi-archive-"));
    dirs.push(squad);
    const workflows = join(squad, "workflows");
    mkdirSync(workflows);
    const file = join(workflows, `${id}.yaml`);
    const load = () =>
      loadWorkflowCatalog(workflows, [id], { localDir: join(squad, "local"), persist: true });
    writeFileSync(file, old);
    const original = (await load()).byId(id);
    writeFileSync(file, current);
    const catalog = await load();
    expect(sha(current)).not.toBe(sha(old));
    expect(catalog.byHash(sha(old))).toEqual(original);
    expect(catalog.byId(id)?.hash).toBe(sha(current));
  },
);
