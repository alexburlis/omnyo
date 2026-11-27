import { describe, expect, it } from "vitest";
import { localhostLinkRewriteDescription } from "./localhost-link-rewrite-description";

describe("localhostLinkRewriteDescription", () => {
  it("describes device-aware routing without an invented hostname", () => {
    expect(localhostLinkRewriteDescription("app.omnyohq.com")).toBe(
      "Open managed previews on localhost on their computer, or through private Omnyo access on another device.",
    );
    expect(localhostLinkRewriteDescription(undefined)).toBeNull();
  });
});
