import { createFileRoute } from "@tanstack/react-router";

import blogCss from "../blog/blog.css?url";
import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { OPERATOR } from "../landing/site";
import legalCss from "../legal/legal.css?url";
import { LegalPage } from "../legal/legal-page";

const PAGE_TITLE = "Imprint — Omnyo";

const PAGE_DESCRIPTION = "Who provides Omnyo and Omnyo connect.";

const LAST_UPDATED = "November 20, 2026";

const LAST_UPDATED_ISO = "2026-11-20";

export const Route = createFileRoute("/imprint")({
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/imprint"),
    links: siteHeadLinks(blogCss, legalCss),
  }),
  component: ImprintRoute,
});

function ImprintRoute() {
  return (
    <LegalPage
      path="/imprint"
      title="Imprint"
      updated={LAST_UPDATED}
      updatedIso={LAST_UPDATED_ISO}
      lede={
        <>
          Impressum nach § 5 DDG. This imprint covers <code>omnyohq.com</code>,{" "}
          <code>omnyo.link</code> and Omnyo connect.
        </>
      }
    >
      <h2>Provider</h2>

      <p>
        {OPERATOR.name}
        {OPERATOR.addressLines.map((line) => (
          <span key={line}>
            <br />
            {line}
          </span>
        ))}
      </p>

      <p>Represented by the managing director {OPERATOR.representative}.</p>

      <h2>Contact</h2>

      <p>
        Email: <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
        <br />
        Phone: {OPERATOR.phone}
      </p>

      <h2>Register</h2>

      <p>
        Commercial register: {OPERATOR.commercialRegister},{" "}
        {OPERATOR.registerCourt}
        <br />
        VAT ID under § 27a UStG: {OPERATOR.vatId}
      </p>

      <h2>Responsible for editorial content</h2>

      <p>{OPERATOR.representative}, address as above (§ 18 Abs. 2 MStV).</p>

      <h2>Consumer dispute resolution</h2>

      <p>
        {OPERATOR.name} is neither obliged nor willing to take part in dispute
        resolution proceedings before a consumer arbitration board.
      </p>
    </LegalPage>
  );
}
