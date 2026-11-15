import { describe, expect, it } from "vitest";
import {
  nextPlanKey,
  planKeyMarker,
  planKeyMarkers,
} from "../../../../src/domain/tasks/plan-key.ts";

describe("nextPlanKey", () => {
  it("starts at 001 when nothing is allocated", () => {
    expect(nextPlanKey("OMI", [])).toBe("OMI-001");
  });

  it("takes the largest allocated number plus one, not the count", () => {
    expect(nextPlanKey("OMI", ["OMI-001", null, "OMI-079", "OMI-003"])).toBe("OMI-080");
  });

  it("counts keys of closed Issues too because the caller passes every allocated key", () => {
    expect(nextPlanKey("OMI", ["OMI-010"])).toBe("OMI-011");
  });

  it("ignores keys of another prefix and malformed keys", () => {
    expect(nextPlanKey("OMI", ["EP-9", "OMX-500", "OMI-7", "omi-400", "OMI-0012"])).toBe("OMI-001");
  });

  it("uses the project prefix it is given", () => {
    expect(nextPlanKey("ACME", ["ACME-004", "OMI-050"])).toBe("ACME-005");
  });

  it("refuses to wrap when the three-digit space is exhausted", () => {
    expect(() => nextPlanKey("OMI", ["OMI-999"])).toThrow(/exhausted/);
  });
});

describe("plan key marker", () => {
  it("renders the marker the dispatcher and bootstrap already read", () => {
    expect(planKeyMarker("OMI-079")).toBe("<!-- omi-squad:plan-key=OMI-079 -->");
  });

  it("finds every marker of a body in order, and none in plain text", () => {
    const body = `a\n${planKeyMarker("OMI-001")}\nb\n<!--omi-squad:plan-key=OMI-002-->`;
    expect(planKeyMarkers(body)).toEqual(["OMI-001", "OMI-002"]);
    expect(planKeyMarkers("no marker here")).toEqual([]);
  });

  it("can be called repeatedly (no shared regex state)", () => {
    const body = planKeyMarker("OMI-001");
    expect(planKeyMarkers(body)).toEqual(["OMI-001"]);
    expect(planKeyMarkers(body)).toEqual(["OMI-001"]);
  });
});
