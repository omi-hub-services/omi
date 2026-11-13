import { expect, it } from "vitest";
import { validateRelease } from "../../../tools/check-release.ts";

const changelog = `# Changelog

## [Unreleased]

### Breaking

## [0.1.0] - 2026-11-13

### Added

- Framework release.

### Breaking

## [0.0.0] - 2026-11-12

### Breaking

- Older change.
`;

it("extracts only the requested version's notes, preserving an empty Breaking section", () => {
  expect(validateRelease({ version: "0.1.0" }, changelog, "v0.1.0")).toBe(
    "### Added\n\n- Framework release.\n\n### Breaking\n",
  );
});

it("rejects a package version without a changelog entry", () => {
  expect(() => validateRelease({ version: "0.2.0" }, changelog)).toThrow(/Missing changelog/);
});

it("rejects a mismatched tag", () => {
  expect(() => validateRelease({ version: "0.1.0" }, changelog, "v0.2.0")).toThrow(/Tag/);
});

it("rejects a version section without Breaking even when another section has it", () => {
  expect(() =>
    validateRelease(
      { version: "0.1.0" },
      changelog.replace("### Breaking\n\n## [0.0.0]", "## [0.0.0]"),
    ),
  ).toThrow(/Breaking/);
});

it.each([null, {}, { version: "01.1.0" }, { version: "0.1" }, { version: "0.1.0-01" }])(
  "rejects invalid package metadata %j",
  (metadata) => {
    expect(() => validateRelease(metadata, changelog)).toThrow(/version/);
  },
);

it("accepts SemVer prerelease and build identifiers", () => {
  expect(
    validateRelease(
      { version: "0.1.0-rc.1+build.2" },
      changelog.replaceAll("[0.1.0]", "[0.1.0-rc.1+build.2]"),
    ),
  ).toContain("Framework release");
});

it("rejects duplicate version entries", () => {
  expect(() => validateRelease({ version: "0.1.0" }, changelog + changelog)).toThrow(/Duplicate/);
});

it("rejects an undated version heading", () => {
  expect(() =>
    validateRelease({ version: "0.1.0" }, changelog.replace("2026-11-13", "soon")),
  ).toThrow(/Missing changelog/);
});
