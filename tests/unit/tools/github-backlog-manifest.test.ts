import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareWithPlan,
  findCycle,
  marker,
  MARKER_PATTERN,
  parseManifest,
  parsePlan,
  renderBody,
  validateManifest,
  type Manifest,
} from "../../../tools/github-bootstrap/manifest.ts";

const repo = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");
const manifest = () => parseManifest(read("docs/planning/github-backlog.yaml"));
const plan = parsePlan(read("docs/planning/project-plan.md"));

describe("docs/planning/github-backlog.yaml", () => {
  it("is valid and matches project-plan.md", () => {
    const m = manifest();
    expect(validateManifest(m)).toEqual([]);
    expect(compareWithPlan(m, plan)).toEqual([]);
  });

  it("has the planned 6 milestones, 8 epics and 48 sub-issues", () => {
    const m = manifest();
    expect(m.milestones.map((x) => x.key)).toEqual(["M0", "M1", "M2", "M3", "M4", "M5"]);
    expect(m.issues.filter((i) => i.type === "epic")).toHaveLength(8);
    expect(m.issues.filter((i) => i.type !== "epic")).toHaveLength(48);
  });

  it("keeps the foundation tasks pulled into M2 instead of their epic's milestone", () => {
    const byKey = new Map(manifest().issues.map((i) => [i.key, i]));
    for (const key of ["OMI-021", "OMI-024", "OMI-026", "OMI-027"]) {
      expect(byKey.get(key)?.milestone).toBe("M2");
    }
    expect(byKey.get("OMI-019")?.milestone).toBe("M3");
  });
});

describe("validateManifest", () => {
  const mutate = (fn: (m: Manifest) => void) => {
    const m = manifest();
    fn(m);
    return validateManifest(m);
  };
  const issue = (m: Manifest, key: string) => {
    const found = m.issues.find((i) => i.key === key);
    if (!found) throw new Error(key);
    return found;
  };

  it("rejects dependency cycles", () => {
    expect(mutate((m) => (issue(m, "OMI-001").blocked_by = ["OMI-007"]))).toContainEqual(
      expect.stringMatching(/^dependency cycle: .*OMI-001.*OMI-007/),
    );
  });

  it("rejects duplicate keys, unknown references and wrong enums", () => {
    const errors = mutate((m) => {
      m.issues.push({ ...issue(m, "OMI-002") });
      issue(m, "OMI-003").blocked_by = ["OMI-999"];
      issue(m, "OMI-004").parent = "EP-99";
      issue(m, "OMI-005").milestone = "M9";
      issue(m, "OMI-006").role = "Coordinator";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "OMI-002: duplicate key",
        "OMI-003: unknown dependency OMI-999",
        "OMI-004: parent must be an existing epic",
        "OMI-005: unknown milestone M9",
        'OMI-006: Role "Coordinator" is not a Project option',
      ]),
    );
  });

  it("rejects tasks without acceptance criteria", () => {
    expect(mutate((m) => (issue(m, "OMI-010").acceptance_criteria = []))).toContain(
      "OMI-010: missing acceptance_criteria",
    );
  });
});

describe("compareWithPlan", () => {
  it("flags a milestone that drifts from project-plan.md §2", () => {
    const m = manifest();
    const t = m.issues.find((i) => i.key === "OMI-024");
    if (t) t.milestone = "M3";
    expect(compareWithPlan(m, plan)).toEqual(['OMI-024: milestone "M3" != plan "M2"']);
  });
});

describe("findCycle", () => {
  it("returns null for a DAG and the cycle otherwise", () => {
    expect(
      findCycle(
        new Map([
          ["a", ["b"]],
          ["b", []],
        ]),
      ),
    ).toBeNull();
    expect(
      findCycle(
        new Map([
          ["a", ["b"]],
          ["b", ["c"]],
          ["c", ["a"]],
        ]),
      ),
    ).toEqual(["a", "b", "c", "a"]);
  });
});

describe("renderBody", () => {
  it("embeds the stable plan-key marker and real dependency URLs", () => {
    const m = manifest();
    const t = m.issues.find((i) => i.key === "OMI-004");
    if (!t) throw new Error("OMI-004");
    const body = renderBody(
      m,
      t,
      new Map([["OMI-002", { number: 3, url: "https://github.com/o/r/issues/3" }]]),
    );
    expect(MARKER_PATTERN.exec(body)?.[1]).toBe("OMI-004");
    expect(body).toContain(marker("OMI-004"));
    expect(body).toContain("Blocked by: https://github.com/o/r/issues/3 (OMI-002)");
    expect(body).toContain("Blocked by: OMI-003 (chưa tạo)");
    expect(body).toContain("- [ ] Hai profile mỗi tool nếu PO cung cấp.");
  });
});
