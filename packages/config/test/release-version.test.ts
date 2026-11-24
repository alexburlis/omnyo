import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION_PATTERN,
  compareReleaseNumbers,
  compareReleaseVersions,
  macBundleVersion,
  parseReleaseVersion,
} from "@omnyo/config/release-version";

describe("parseReleaseVersion", () => {
  it.each([
    ["0.46.378+private.1", "0.46.378", 1],
    ["1.0.0+private.1", "1.0.0", 1],
    ["1.0.1", "1.0.1", null],
    ["12.0.10+private.23", "12.0.10", 23],
  ])("parses %s", (value, numeric, revision) => {
    expect(parseReleaseVersion(value)).toMatchObject({ numeric, revision });
    expect(RELEASE_VERSION_PATTERN.test(value)).toBe(true);
  });

  it.each([
    "",
    "1.0",
    "v1.0.0",
    "01.0.0",
    "1.0.0+private",
    "1.0.0+private.",
    "1.0.0+build.1",
    "1.0.0-beta.1",
    "1.0.0+private.1 ",
    "0.46.378+private.1+private.2",
  ])("rejects %j", (value) => {
    expect(parseReleaseVersion(value)).toBeNull();
    expect(RELEASE_VERSION_PATTERN.test(value)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(parseReleaseVersion(undefined)).toBeNull();
    expect(parseReleaseVersion(1)).toBeNull();
  });
});

describe("release ordering", () => {
  it("orders the bridge after the last 0.46 release and before untagged 1.x", () => {
    const versions = [
      "1.0.1",
      "0.46.378+private.1",
      "1.0.0+private.1",
      "0.46.9+private.3",
      "1.0.2+private.1",
    ];

    expect([...versions].sort(compareReleaseVersions)).toEqual([
      "0.46.9+private.3",
      "0.46.378+private.1",
      "1.0.0+private.1",
      "1.0.1",
      "1.0.2+private.1",
    ]);
  });

  it("breaks numeric ties on the revision, with an untagged version first", () => {
    expect(compareReleaseVersions("1.0.0+private.2", "1.0.0+private.1")).toBe(
      1,
    );
    expect(compareReleaseVersions("1.0.0", "1.0.0+private.1")).toBe(-1);
    expect(compareReleaseVersions("1.0.0+private.1", "1.0.0")).toBe(1);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseNumbers("1.0.0", "1.0.0+private.7")).toBe(0);
  });

  it("refuses invalid input instead of guessing an order", () => {
    expect(() => compareReleaseVersions("1.0", "1.0.0")).toThrow(
      "Invalid Omnyo release version: 1.0",
    );
    expect(() => compareReleaseNumbers("1.0.0", "1.0.0-beta")).toThrow();
  });
});

describe("macBundleVersion", () => {
  it("uses the revision for tagged versions and the numeric version otherwise", () => {
    expect(macBundleVersion("0.46.378+private.1")).toBe("1");
    expect(macBundleVersion("1.0.0+private.1")).toBe("1");
    expect(macBundleVersion("1.0.1")).toBe("1.0.1");
  });
});
