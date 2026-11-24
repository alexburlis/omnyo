import { createFileRoute } from "@tanstack/react-router";

import blogCss from "../blog/blog.css?url";
import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { OPERATOR } from "../landing/site";
import legalCss from "../legal/legal.css?url";
import {
  CookieSettingsButton,
  CookieSettingsLink,
  LegalContents,
  LegalHeading,
  LegalPage,
  LegalSummary,
  StorageGroupList,
} from "../legal/legal-page";
import {
  CONNECT_STORAGE,
  CONSENT_DAYS,
  WEBSITE_STORAGE,
} from "../legal/website-storage";

const PAGE_TITLE = "Cookie policy — Omnyo";

const PAGE_DESCRIPTION =
  "Every cookie and storage key that omnyohq.com and Omnyo connect use, what each one is for, how long it lasts, and how to change your choice.";

const LAST_UPDATED = "November 24, 2026";

const LAST_UPDATED_ISO = "2026-11-24";

const SECTIONS = {
  website: { id: "website", title: "Cookies on omnyohq.com" },
  connect: { id: "connect", title: "Cookies on Omnyo connect" },
  read: { id: "read-not-stored", title: "What we read but do not store" },
  change: { id: "change", title: "Change or withdraw your choice" },
  contact: { id: "contact", title: "Contact" },
} as const;

export const Route = createFileRoute("/cookies")({
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/cookies"),
    links: siteHeadLinks(blogCss, legalCss),
  }),
  component: CookiesRoute,
});

function CookiesRoute() {
  return (
    <LegalPage
      path="/cookies"
      title="Cookie policy"
      updated={LAST_UPDATED}
      updatedIso={LAST_UPDATED_ISO}
      lede={
        <>
          This page lists every cookie and browser storage key that this website
          and Omnyo connect use: what each one is for, who sets it, and how long
          it lasts. The <a href="/privacy">privacy policy</a> explains what
          happens to the data.
        </>
      }
    >
      <LegalSummary
        footer={
          <>
            <p>You can change or withdraw your choice at any time.</p>
            <CookieSettingsButton>Open cookie settings</CookieSettingsButton>
          </>
        }
      >
        <li>Until you choose, this website sets no cookies.</li>
        <li>
          While you browse, the site keeps your scroll position in this tab’s
          session storage, so Back returns you to the same place. It never
          leaves your browser.
        </li>
        <li>
          If you switch between light and dark mode, the site remembers that
          choice in this browser’s local storage. It never leaves your browser.
        </li>
        <li>
          Two necessary cookies remember your choice for {CONSENT_DAYS} days.
        </li>
        <li>
          Usage analytics writes no visitor ID, session key or analytics cookie.
          It uses only your saved purpose choice.
        </li>
        <li>Error reports store nothing in your browser.</li>
        <li>
          Omnyo connect sets only the cookies it needs to sign you in and
          protect your address.
        </li>
        <li>
          We use no advertising cookies, and nothing optional runs when your
          browser sends Global Privacy Control or Do Not Track.
        </li>
      </LegalSummary>

      <LegalContents sections={Object.values(SECTIONS)} />

      <LegalHeading section={SECTIONS.website} />

      {WEBSITE_STORAGE.map((group) => (
        <StorageGroupList key={group.id} group={group} />
      ))}

      <h3>Usage analytics: no visitor storage</h3>

      <p>
        Usage analytics sends only the fixed events in our{" "}
        <a href="/privacy#data-dictionary">data dictionary</a>. It creates no
        visitor identifier or browser queue. The site removes leftover PostHog
        cookies and storage from earlier website versions when this version
        opens. Those earlier versions used PostHog; removing local storage does
        not erase events they already sent.
      </p>

      <h3>Error reports: nothing stored</h3>

      <p>
        Sentry sets no cookies and stores nothing in your browser. With Error
        reports on, the site loads Sentry’s code and sends a report when a
        script fails, as the <a href="/privacy#website">privacy policy</a>{" "}
        describes.
      </p>

      <h3>Shared workflow pages</h3>

      <p>
        Pages under <code>omnyohq.com/w/</code> load no scripts and set no
        cookies, whatever you chose.
      </p>

      <LegalHeading section={SECTIONS.connect} />

      <StorageGroupList group={CONNECT_STORAGE} />

      <p>
        All of these cookies are sent only over HTTPS and cannot be read by
        scripts on the page. Your own Omnyo server can also set cookies on your
        address; those belong to your server, not to us.
      </p>

      <LegalHeading section={SECTIONS.read} />

      <ul>
        <li>
          <strong>Your operating system and screen type</strong>, to show the
          right download button. The check runs in your browser and stores
          nothing.
        </li>
        <li>
          <strong>Your light or dark setting</strong>, to match the site’s
          colors. The check runs in your browser and stores nothing.
        </li>
        <li>
          <strong>Global Privacy Control and Do Not Track</strong>, which we
          treat as your objection: the banner stays closed and both optional
          purposes stay off. Your browser and our server read these signals and
          keep no record of them.
        </li>
      </ul>

      <p>
        Fonts, images and scripts come from <code>omnyohq.com</code> itself. We
        use no advertising cookies, tracking pixels or social media plugins. If
        you follow a link to GitHub or download Omnyo from there, GitHub may set
        its own cookies on <code>github.com</code> under its own policy.
      </p>

      <LegalHeading section={SECTIONS.change} />

      <p>
        Use <CookieSettingsLink /> at the bottom of any page to turn Usage
        analytics or Error reports on or off. Turning a purpose off stops new
        requests for that purpose and cancels pending browser requests. No page
        reload is needed. A request that already arrived cannot be recalled.
        Withdrawing does not erase data collected before.
      </p>

      <p>
        Your choice applies to the browser you made it in. After {CONSENT_DAYS}{" "}
        days, or if you delete this site’s cookies in your browser settings, we
        ask again. Blocking all cookies keeps both optional purposes off; the
        site still works.
      </p>

      <LegalHeading section={SECTIONS.contact} />

      <p>
        {OPERATOR.name}, {OPERATOR.addressLines.join(", ")}.{" "}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>. See also the{" "}
        <a href="/privacy">privacy policy</a> and the{" "}
        <a href="/imprint">imprint</a>.
      </p>
    </LegalPage>
  );
}
