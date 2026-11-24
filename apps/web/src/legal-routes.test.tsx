import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ABUSE_EMAIL, OPERATOR } from "./landing/site";
import { Route as AbuseRoute } from "./routes/abuse";
import { Route as CookiesRoute } from "./routes/cookies";
import { Route as ImprintRoute } from "./routes/imprint";
import { Route as PrivacyRoute } from "./routes/privacy";
import { Route as TermsRoute } from "./routes/terms";

function render(route: { options: { component?: unknown } }): string {
  const Page = route.options.component as
    | (() => React.ReactElement)
    | undefined;

  if (Page === undefined) throw new Error("The route has no page");

  return renderToStaticMarkup(<Page />);
}

describe("legal pages", () => {
  it.each([
    ["privacy", PrivacyRoute],
    ["terms", TermsRoute],
    ["imprint", ImprintRoute],
    ["cookies", CookiesRoute],
  ])(
    "%s names the operator and a working contact, without iubenda",
    (_, route) => {
      const html = render(route);

      expect(html).toContain(OPERATOR.name);
      expect(html).toContain(`mailto:${OPERATOR.email}`);
      expect(html).not.toContain("iubenda");
    },
  );

  it("gives the imprint's register details", () => {
    const html = render(ImprintRoute);

    expect(html).toContain(OPERATOR.commercialRegister);
    expect(html).toContain(OPERATOR.registerCourt);
    expect(html).toContain(OPERATOR.vatId);
    expect(html).toContain(OPERATOR.representative);
  });

  it("states the relay limits and German law in the terms", () => {
    const html = render(TermsRoute);

    expect(html).toContain("100 GB of traffic per account");
    expect(html).toContain("5 servers and 20 devices");
    expect(html).toContain("German law applies");
    expect(html).toContain("How the contract is made");
    expect(html).toContain("The contract language is English.");
  });

  it.each([
    ["privacy", PrivacyRoute],
    ["terms", TermsRoute],
    ["imprint", ImprintRoute],
    ["cookies", CookiesRoute],
    ["abuse", AbuseRoute],
  ])("%s uses the shared legal layout", (_, route) => {
    const html = render(route);

    expect(html).toContain('class="post article legal-doc"');
    expect(html).toContain('class="date-pill"');
  });

  it("tells people where to report abuse", () => {
    expect(render(AbuseRoute)).toContain(`mailto:${ABUSE_EMAIL}`);
    expect(render(PrivacyRoute)).toContain('href="/abuse"');
  });
});
