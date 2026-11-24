import { describe, expect, it } from "vitest";
import { dashboardPage, errorPage, securityTxt, signInPage } from "./html.js";

describe("relay legal links", () => {
  it("tells people at sign-in that they accept the terms", () => {
    const html = signInPage("/dashboard", null);

    expect(html).toContain("By signing in you accept the");
    expect(html).toContain('href="https://omnyohq.com/terms"');
    expect(html).toContain('href="https://omnyohq.com/privacy"');
  });

  it("links terms, privacy, imprint and abuse reports from every page", () => {
    for (const html of [signInPage("/dashboard", null), errorPage(404)]) {
      for (const path of ["/terms", "/privacy", "/imprint", "/abuse"]) {
        expect(html).toContain(`href="https://omnyohq.com${path}"`);
      }
    }

    expect(dashboardPage).toBeTypeOf("function");
  });

  it("publishes a security.txt for its own domain that expires within a year", () => {
    const at = Date.UTC(2026, 10, 11);

    const text = securityTxt({
      appUrl: "https://stg.omnyo.link",
      contact: "abuse@omnyo.link",
      at,
    });

    expect(text).toContain("Contact: mailto:abuse@omnyo.link");
    expect(text).toContain(
      "Canonical: https://stg.omnyo.link/.well-known/security.txt",
    );
    expect(text).not.toContain("https://omnyo.link/");
    expect(text).toContain("Policy: https://omnyohq.com/abuse");
    const expires = /^Expires: (.+)$/mu.exec(text)?.[1];

    if (expires === undefined) throw new Error("security.txt has no Expires");
    const lifetime = Date.parse(expires) - at;

    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThan(365 * 24 * 60 * 60 * 1000);
  });
});
