import { describe, expect, it } from "vitest";
import {
  hasOperationMarker,
  isValidOperationKey,
  operationMarker,
} from "../../../../src/domain/delivery/operation-marker.ts";

describe("operation marker", () => {
  it("is a single HTML comment derived from the key", () => {
    expect(operationMarker("create-pr:acme/app:task-1:task/omi-1:develop")).toBe(
      "<!-- omi-squad:operation:create-pr:acme/app:task-1:task/omi-1:develop -->",
    );
  });

  it("matches only the exact key, never a key that is its prefix", () => {
    const text = `body\n\n${operationMarker("comment:run-12")}`;
    expect(hasOperationMarker(text, "comment:run-12")).toBe(true);
    expect(hasOperationMarker(text, "comment:run-1")).toBe(false);
    expect(hasOperationMarker("no marker here", "comment:run-12")).toBe(false);
  });

  it.each(["", " key", "a b", "a--b", "a>b", "a\nb", "-leading", "x".repeat(201)])(
    "refuses the key %j so the marker cannot leave its comment",
    (key) => {
      expect(isValidOperationKey(key)).toBe(false);
      expect(() => operationMarker(key)).toThrow(RangeError);
    },
  );

  it("accepts a 200 character key", () => {
    expect(isValidOperationKey("x".repeat(200))).toBe(true);
  });
});
