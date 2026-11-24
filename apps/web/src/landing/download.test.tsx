import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DownloadButton, DownloadPanel, PlatformRail } from "./download";
import { parsePublicMacDownload } from "./mac-download.server";
import { PLATFORMS, PLATFORMS_ANCHOR, PLATFORM_LINE } from "./platforms";
import { MACOS_DOWNLOAD_URL } from "./site";

const anchors = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>/gu)].map((match) => match[0]);

describe("download controls", () => {
  it("links Mac to its build and every other device to the platforms panel", () => {
    for (const size of ["md", "lg"] as const) {
      const html = renderToStaticMarkup(<DownloadButton size={size} />);
      const links = anchors(html);

      expect(links).toHaveLength(4);
      expect(html).not.toMatch(/<a (?![^>]*href=)/u);

      for (const link of links) {
        expect(link).toContain(`get-btn--${size}`);
        expect(
          link.includes(`href="${MACOS_DOWNLOAD_URL}"`) ||
            link.includes(`href="${PLATFORMS_ANCHOR}"`),
        ).toBe(true);
      }

      expect(html).toContain("Download for Windows");
      expect(html).toContain("Get Omnyo for iPhone");
      expect(html).toContain("Get Omnyo for iPad");
    }
  });

  it("lists every platform and renders the ones without a link as plain cells", () => {
    const html = renderToStaticMarkup(<PlatformRail />);

    expect(anchors(html)).toHaveLength(1);
    expect(anchors(html)[0]).toContain(`href="${MACOS_DOWNLOAD_URL}"`);
    expect(html.match(/get-rail-cell is-soon/gu)).toHaveLength(1);
    expect(html).toContain("App Store");
    expect(html).not.toMatch(/<a (?![^>]*href=)/u);
  });

  it("keeps the panel free of links without a destination", () => {
    const html = renderToStaticMarkup(<DownloadPanel />);

    expect(html).not.toMatch(/<a (?![^>]*href=)/u);
    expect(PLATFORM_LINE).toBe("Mac · Windows · iOS · Web · Android soon");
    expect(PLATFORMS.filter((platform) => platform.href)).toHaveLength(1);
  });

  it("pairs the Mac version with its versioned installer on both download controls", () => {
    const macDownload = parsePublicMacDownload(
      "version: 1.2.3\nfiles:\n  - url: omnyo-1.2.3-arm64.zip\n",
    );

    const html = renderToStaticMarkup(
      <DownloadPanel macDownload={macDownload} />,
    );

    expect(macDownload).toEqual({
      version: "1.2.3",
      url: new URL("omnyo-1.2.3-arm64.zip", MACOS_DOWNLOAD_URL).href,
    });
    expect(
      anchors(html).filter((link) => link.includes("omnyo-1.2.3-arm64.zip")),
    ).toHaveLength(2);
    expect(html.match(/v1\.2\.3/gu)).toHaveLength(2);
    expect(html).toContain(`href="${PLATFORMS_ANCHOR}"`);
  });

  it("omits a version when the feed names a different installer", () => {
    const macDownload = parsePublicMacDownload(
      "version: 1.2.3\nfiles:\n  - url: omnyo-1.2.2-arm64.zip\n",
    );

    const html = renderToStaticMarkup(
      <DownloadPanel macDownload={macDownload} />,
    );

    expect(macDownload).toBeNull();
    expect(html).not.toContain("v1.2.3");
    expect(html).toContain(`href="${MACOS_DOWNLOAD_URL}"`);
  });
});
