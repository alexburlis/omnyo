import { describe, expect, it } from "vitest";
import {
  parseManagedPreviewHref,
  resolveManagedPreviewHref,
} from "./managed-preview-url";

const origin = "https://omnyo.example.com";

const href = `${origin}/preview/prv_fixture/next/path?q=2#ready`;

const binding = {
  id: "prv_fixture",
  hostId: "host_owner",
  url: "http://localhost:3237/initial?q=1#first",
};

describe("managed preview URL routing", () => {
  it("uses the binding origin and the requested route on the proven owner", () => {
    const preview = parseManagedPreviewHref(href, origin)!;
    expect(
      resolveManagedPreviewHref({
        href,
        preview,
        binding,
        viewerHostId: "host_owner",
      }),
    ).toBe("http://localhost:3237/next/path?q=2#ready");
  });
  it.each(["host_other", null])(
    "preserves the private route on viewer %s",
    (viewerHostId) => {
      const preview = parseManagedPreviewHref(href, origin)!;
      expect(
        resolveManagedPreviewHref({ href, preview, binding, viewerHostId }),
      ).toBe(href);
    },
  );
  it("never adopts a different binding or a non-loopback origin", () => {
    const preview = parseManagedPreviewHref(href, origin)!;

    for (const value of [
      undefined,
      { ...binding, id: "prv_other" },
      { ...binding, url: "https://unrelated.example/" },
    ]) {
      expect(
        resolveManagedPreviewHref({
          href,
          preview,
          binding: value,
          viewerHostId: "host_owner",
        }),
      ).toBe(href);
    }
  });
  it.each([
    ["http://127.0.0.1:3237/", "http://localhost:3237/next/path?q=2#ready"],
    ["https://127.0.0.1:8443/", "https://127.0.0.1:8443/next/path?q=2#ready"],
  ])("resolves the registered loopback origin %s", (url, expected) => {
    const preview = parseManagedPreviewHref(href, origin)!;
    expect(
      resolveManagedPreviewHref({
        href,
        preview,
        binding: { ...binding, url },
        viewerHostId: "host_owner",
      }),
    ).toBe(expected);
  });

  it("preserves IPv6, encoded paths, query and fragment", () => {
    const requested = "/preview/prv_fixture/a%20b?q=%2F#x%20y";
    const preview = parseManagedPreviewHref(requested, origin)!;
    expect(
      resolveManagedPreviewHref({
        href: requested,
        preview,
        binding: { ...binding, url: "https://[::1]:8443/" },
        viewerHostId: "host_owner",
      }),
    ).toBe("https://[::1]:8443/a%20b?q=%2F#x%20y");
  });
  it("does not interpret a double-slash path as another destination", () => {
    const preview = parseManagedPreviewHref(
      "/preview/prv_fixture//external.example/x",
      origin,
    )!;

    expect(
      resolveManagedPreviewHref({
        href,
        preview,
        binding,
        viewerHostId: "host_owner",
      }),
    ).toBe("http://localhost:3237//external.example/x");
  });
  it("supports a binding root with no trailing slash", () => {
    const preview = parseManagedPreviewHref(
      "/preview/prv_fixture?q=1#first",
      origin,
    )!;

    expect(preview.pathname).toBe("/");
    expect(
      resolveManagedPreviewHref({
        href,
        preview,
        binding,
        viewerHostId: "host_owner",
      }),
    ).toBe("http://localhost:3237/?q=1#first");
  });
  it.each([
    "https://elsewhere.example/preview/prv_fixture/",
    "https://user@omnyo.example.com/preview/prv_fixture/",
    "/preview/prv%2Ffixture/",
    "/preview/prv%5Cfixture/",
    "/preview/%00/",
    "/preview/%zz/",
    "/settings",
    "javascript:alert(1)",
  ])("leaves unrelated or malformed URL %s alone", (value) => {
    expect(parseManagedPreviewHref(value, origin)).toBeNull();
  });
});
