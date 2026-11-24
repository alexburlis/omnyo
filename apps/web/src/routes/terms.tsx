import { createFileRoute } from "@tanstack/react-router";

import blogCss from "../blog/blog.css?url";
import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { GITHUB_URL, OPERATOR } from "../landing/site";
import legalCss from "../legal/legal.css?url";
import { LegalPage } from "../legal/legal-page";

const PAGE_TITLE = "Terms of service — Omnyo";

const PAGE_DESCRIPTION =
  "The terms for Omnyo connect, the optional free relay that gives your Omnyo server an address under omnyo.link, and for the workflow links you share through it.";

const LAST_UPDATED = "November 24, 2026";

const LAST_UPDATED_ISO = "2026-11-24";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/terms"),
    links: siteHeadLinks(blogCss, legalCss),
  }),
  component: TermsRoute,
});

function TermsRoute() {
  return (
    <LegalPage
      path="/terms"
      title="Terms of service"
      updated={LAST_UPDATED}
      updatedIso={LAST_UPDATED_ISO}
      lede={
        <>
          These terms cover Omnyo connect, the free relay that gives the Omnyo
          server on your own machine an address such as{" "}
          <code>yourhandle.omnyo.link</code>, and the workflow links you share
          through it. You do not need Omnyo connect to use Omnyo.
        </>
      }
    >
      <p>
        {OPERATOR.name}, {OPERATOR.addressLines.join(", ")}, provides Omnyo
        connect.
      </p>

      <h2>How the contract is made</h2>

      <p>
        You make the contract for Omnyo connect when you sign in with GitHub on{" "}
        <code>omnyo.link</code>. The sign-in page links to these terms. We do
        not keep a copy of the contract for you. This page always shows the
        current version and its date, and you can save or print it. The contract
        language is English.
      </p>

      <h2>The Omnyo app</h2>

      <p>
        The Omnyo app is free under the MIT License. Its{" "}
        <a href={GITHUB_URL}>downloads are on GitHub</a>. That license, not
        these terms, sets what you may do with the app. You can use it without
        an account.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>
          You sign in with a GitHub account. You get one handle, and you cannot
          change it yourself.
        </li>
        <li>
          Some names are reserved, including names that contain{" "}
          <code>omnyo</code>, <code>slashnew</code> or <code>github</code>. We
          can refuse or take back a handle that imitates someone else, a brand,
          or part of this service.
        </li>
        <li>
          Keep your pairing codes and credentials private. Anyone who holds a
          device credential can reach your server until you revoke that device
          in your dashboard.
        </li>
        <li>
          You can connect up to 5 servers and 20 devices. You can disconnect or
          revoke each of them in your dashboard at any time.
        </li>
      </ul>

      <h2>What is yours</h2>

      <p>
        Your server, your code, your prompts, and everything you send through
        your address stay yours. You are responsible for what your server does
        and for what you share through shared ports, preview links and workflow
        links.
      </p>

      <h2>Sharing workflows</h2>

      <p>
        You can upload a workflow file and share it as a link. Anyone with the
        link can see its preview and download the file until the link expires,
        after 30 days unless you choose up to 90, or until you revoke it. Copies
        that people have already downloaded stay with them.
      </p>
      <ul>
        <li>
          Share only workflows you have the right to share. Leave out
          credentials and private client material.
        </li>
        <li>
          We do not review shared workflows. If you receive one, read its
          instructions before you use it, and approve its inputs and each run
          yourself.
        </li>
        <li>
          A link gives nobody access to your computer, your accounts, or the
          places you publish to.
        </li>
      </ul>

      <h2>What you must not do</h2>
      <ul>
        <li>
          Do not use your address or a workflow link for phishing, malware, or
          content that is illegal in Germany or where you are.
        </li>
        <li>
          Do not attack, scan, or overload this service or anyone else through
          it.
        </li>
        <li>
          Do not use it as a public proxy, and do not resell or sublet it.
        </li>
        <li>
          Do not try to reach another user&rsquo;s address or to get around the
          limits below.
        </li>
      </ul>

      <h2>Limits</h2>
      <ul>
        <li>
          The relay carries up to 100 GB of traffic per account each calendar
          month. When you reach the limit, your address shows a notice until the
          next month.
        </li>
        <li>
          Sign-in, pairing, previews, and installer downloads are rate limited
          to stop abuse.
        </li>
        <li>
          We can lower these limits for the future with at least 30 days&rsquo;
          notice on <code>omnyo.link</code>, or at once when that is needed to
          stop abuse or to keep the relay running.
        </li>
      </ul>

      <h2>Availability</h2>

      <p>
        Omnyo connect is an early service run by one person. It can be slow,
        interrupted, or unavailable. We can end Omnyo connect with at least 30
        days&rsquo; notice on <code>omnyo.link</code>, or sooner for an
        important reason. Your Omnyo server keeps working on your own network
        without it.
      </p>

      <h2>Suspension</h2>

      <p>
        We can suspend or remove an account, a handle, a server, a device, or a
        workflow link that breaks these terms or the law, puts other people at
        risk, or is the subject of a credible abuse report. A person makes every
        decision. We store only GitHub&rsquo;s no-reply address for your
        account, so we usually cannot write to you first. If you think we made a
        mistake, write to{" "}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a> with your
        handle, and we look at it again. To report abuse, see{" "}
        <a href="/abuse">Report abuse</a>.
      </p>

      <h2>Ending your account</h2>

      <p>
        You can stop using Omnyo connect at any time. To delete your account,
        write to <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>. The{" "}
        <a href="/privacy">privacy page</a> lists what we delete and what we
        keep.
      </p>

      <h2>Privacy</h2>

      <p>
        The <a href="/privacy">privacy page</a> describes what the relay stores
        and what it can see. The relay handles your traffic while it passes
        through. Do not use it if that is not acceptable for your data.
      </p>

      <h2>Liability</h2>

      <p>
        Omnyo connect is free. We do not promise that it is always available,
        free of errors, or suitable for a particular purpose.
      </p>

      <p>
        We are liable without limit for intent and gross negligence, for injury
        to life, body, or health, under the German Product Liability Act, and
        where we have given a guarantee. For slight negligence we are liable
        only when we breach an essential obligation, one that makes the service
        possible at all and that you may rely on, and then only for the typical
        damage we could foresee. Otherwise we are not liable for slight
        negligence. Where the law limits our liability further because the
        service is free, that limit applies. These rules also cover the people
        who act for us.
      </p>

      <h2>Law</h2>

      <p>
        German law applies. If you are a consumer, you keep the protection of
        the mandatory rules of the country where you usually live. If you are a
        merchant or a legal entity or special fund under public law, the courts
        in Düren have exclusive jurisdiction.
      </p>

      <h2>Changes</h2>

      <p>
        We can change these terms for the future, for example when the service
        or the law changes. The date at the top of this page shows the current
        version. The sign-in page links to these terms, and signing in after a
        change means you accept the new version. Until then, the earlier version
        applies to you. If you do not want the new version, stop using Omnyo
        connect and ask us to delete your account.
      </p>

      <h2>Contact</h2>

      <p>
        For questions about these terms, write to{" "}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>. For abuse and
        security reports, see <a href="/abuse">Report abuse</a>. Our full
        details are in the <a href="/imprint">imprint</a>.
      </p>
    </LegalPage>
  );
}
