import { describe, expect, it } from "vitest";
import { webBundleRelease, webSourceRevision } from "./vite-web-release.js";

describe("web bundle release identity", () => {
  it("identifies loaded asset bytes independently of HTML and output ordering", () => {
    const first = {
      type: "asset" as const,
      fileName: "assets/a.js",
      source: "first",
      names: [],
      originalFileNames: [],
      needsCodeReference: false,
    };

    const second = {
      type: "asset" as const,
      fileName: "assets/b.css",
      source: "second",
      names: [],
      originalFileNames: [],
      needsCodeReference: false,
    };

    const html = {
      type: "asset" as const,
      fileName: "index.html",
      source: "old",
      names: [],
      originalFileNames: [],
      needsCodeReference: false,
    };

    const release = webBundleRelease({ a: first, b: second, html });
    expect(release).toMatch(/^web-[a-f0-9]{64}$/);
    expect(
      webBundleRelease({
        b: second,
        html: { ...html, source: release },
        a: first,
      }),
    ).toBe(release);
    expect(
      webBundleRelease({ a: first, b: { ...second, source: "new" } }),
    ).not.toBe(release);
  });

  it("takes the source revision from the build environment when it is set", async () => {
    const revision = "a".repeat(40);

    await expect(
      webSourceRevision("/nonexistent", {
        OMNYO_WEB_SOURCE_REVISION: `${revision}\n`,
      }),
    ).resolves.toBe(revision);
    await expect(
      webSourceRevision("/nonexistent", {
        OMNYO_WEB_SOURCE_REVISION: "$Format:%H$",
      }),
    ).rejects.toThrow("Invalid web source revision");
  });
});
