import { describe, expect, it } from "vitest";
import {
  parseLoopbackPreviewUrl,
  rewriteLocalhostLinkHref,
} from "../src/localhost-link-rewrite.js";

describe("device-aware preview links", () => {
  const href = "http://localhost:4399/compare/superwhisper?debug=1#ready";
  const remoteBaseUrl = "/preview/prv_original_host";
  it("preserves the exact original URL on a confirmed owner device", () => {
    expect(
      rewriteLocalhostLinkHref({
        enabled: true,
        href,
        sourceHostId: "mac",
        viewerHostId: "mac",
        remoteBaseUrl,
      }),
    ).toBe(href);
  });
  it.each(["phone", null, undefined])(
    "uses Omnyo access for a different or unproven viewer %s",
    (viewerHostId) => {
      expect(
        rewriteLocalhostLinkHref({
          enabled: true,
          href,
          sourceHostId: "mac",
          viewerHostId,
          remoteBaseUrl,
        }),
      ).toBe(`${remoteBaseUrl}/compare/superwhisper?debug=1#ready`);
    },
  );
  it("never invents a coordinator hostname with a development port", () => {
    expect(rewriteLocalhostLinkHref({ enabled: true, href })).toBe(href);
  });
  it.each(["http://127.0.0.1:4399/a?q=1#x", "https://[::1]:8443/a?q=1#x"])(
    "preserves paths, query and fragment for %s",
    (href) => {
      expect(
        rewriteLocalhostLinkHref({ enabled: true, href, remoteBaseUrl }),
      ).toBe(`${remoteBaseUrl}/a?q=1#x`);
    },
  );
  it("keeps two owners on the same port separate", () => {
    expect(
      rewriteLocalhostLinkHref({
        enabled: true,
        href,
        sourceHostId: "air",
        viewerHostId: "mac",
        remoteBaseUrl: "/preview/prv_air",
      }),
    ).toBe("/preview/prv_air/compare/superwhisper?debug=1#ready");
  });
  it.each([
    "https://example.com/docs",
    "mailto:hi@example.com",
    "/projects/proj_123",
    "file:///workspace/app.ts",
    "http://localhost.evil:4399/",
    "http://user:password@localhost:4399/",
    "ftp://localhost:4399/",
    "not a url",
    undefined,
  ])("leaves other links unchanged: %s", (href) => {
    expect(parseLoopbackPreviewUrl(href)).toBeNull();
    expect(
      rewriteLocalhostLinkHref({ enabled: true, href, remoteBaseUrl }),
    ).toBe(href);
  });
  it("honors an explicit disabled preference", () => {
    expect(
      rewriteLocalhostLinkHref({ enabled: false, href, remoteBaseUrl }),
    ).toBe(href);
  });
});
