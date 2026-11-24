import { createFileRoute } from "@tanstack/react-router";

import blogCss from "../blog/blog.css?url";
import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { ABUSE_EMAIL, OPERATOR } from "../landing/site";
import legalCss from "../legal/legal.css?url";
import { LegalPage } from "../legal/legal-page";

const PAGE_TITLE = "Report abuse — Omnyo connect";

const PAGE_DESCRIPTION =
  "Report phishing, malware, illegal content, or an attack from an address under omnyo.link or a shared workflow link.";

const LAST_UPDATED = "November 20, 2026";

const LAST_UPDATED_ISO = "2026-11-20";

export const Route = createFileRoute("/abuse")({
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/abuse"),
    links: siteHeadLinks(blogCss, legalCss),
  }),
  component: AbuseRoute,
});

function AbuseRoute() {
  return (
    <LegalPage
      path="/abuse"
      title="Report abuse"
      updated={LAST_UPDATED}
      updatedIso={LAST_UPDATED_ISO}
      lede={
        <>
          Addresses under <code>omnyo.link</code> lead to Omnyo servers that
          people run on their own machines, and workflow links lead to files
          that people uploaded. We do not check either in advance, but we act on
          reports.
        </>
      }
    >
      <h2>What to send</h2>

      <p>
        Write to <a href={`mailto:${ABUSE_EMAIL}`}>{ABUSE_EMAIL}</a> about
        phishing, malware, illegal content, or an attack that comes from an
        address under <code>omnyo.link</code> or from a shared workflow link.
        Please include:
      </p>
      <ul>
        <li>The full address or workflow link.</li>
        <li>What you saw, and when.</li>
        <li>Why you think it is illegal or breaks our terms.</li>
        <li>
          Your name and email address, and a statement that your report is
          accurate and complete to the best of your knowledge. When you report
          child sexual abuse material, you can leave out your name and email
          address.
        </li>
      </ul>

      <h2>What happens next</h2>

      <p>
        We confirm that your report arrived, read it within two working days,
        and tell you what we decided. A person reads every report and makes
        every decision; we use no automated tools. When a report is credible, we
        suspend the address or revoke the workflow link. Revoking a link stops
        new downloads; we cannot remove copies that people have already
        downloaded.
      </p>

      <h2>Security problems</h2>

      <p>
        To report a security problem in Omnyo connect itself, write to the same
        address with &ldquo;security&rdquo; in the subject. Please give us time
        to fix it before you publish it.
      </p>

      <h2>Contact under the Digital Services Act</h2>

      <p>
        <a href={`mailto:${ABUSE_EMAIL}`}>{ABUSE_EMAIL}</a> is our single point
        of contact for users, authorities, and the European Commission under
        Articles 11 and 12 of the Digital Services Act. You can write in English
        or German. The provider is {OPERATOR.name}; see the{" "}
        <a href="/imprint">imprint</a>.
      </p>
    </LegalPage>
  );
}
