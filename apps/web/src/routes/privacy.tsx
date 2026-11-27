import { createFileRoute } from "@tanstack/react-router";
import { SITE_USAGE_DICTIONARY } from "@omnyo/domain/site-usage";

import blogCss from "../blog/blog.css?url";
import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { ABUSE_EMAIL, GITHUB_URL, OPERATOR } from "../landing/site";
import legalCss from "../legal/legal.css?url";
import { PRODUCT_USAGE_DICTIONARY } from "../legal/product-data-dictionary";
import {
  CookieSettingsLink,
  LegalContents,
  LegalHeading,
  LegalPage,
  LegalSummary,
} from "../legal/legal-page";
import {
  CONSENT_DAYS,
  LEGACY_POSTHOG_EVENT_RETENTION,
  LEGACY_REPLAY_RETENTION_DAYS,
  SENTRY_RETENTION_DAYS,
} from "../legal/website-storage";

const PAGE_TITLE = "Privacy policy — Omnyo";

const PAGE_DESCRIPTION =
  "What Omnyo collects, what stays on your own machines, what Omnyo connect can see, and how this website asks before it measures anything.";

const LAST_UPDATED = "November 24, 2026";

const LAST_UPDATED_ISO = "2026-11-24";

const GITHUB_PRIVACY_URL =
  "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement";

const COMPLAINT_URL = "https://www.ldi.nrw.de/beschwerde";

const SECTIONS = {
  controller: { id: "controller", title: "Who is responsible" },
  apps: { id: "apps", title: "The Omnyo apps" },
  connect: { id: "connect", title: "Omnyo connect" },
  workflows: { id: "workflow-links", title: "Shared workflow links" },
  website: { id: "website", title: "This website" },
  dictionary: { id: "data-dictionary", title: "Usage data dictionary" },
  email: { id: "email", title: "Email to us" },
  providers: { id: "providers", title: "Service providers and transfers" },
  retention: { id: "retention", title: "Keeping and deleting data" },
  rights: { id: "rights", title: "Your rights" },
  limits: { id: "what-we-do-not-do", title: "What we do not do" },
  children: { id: "children", title: "Children" },
  changes: { id: "changes", title: "Changes" },
  contact: { id: "contact", title: "Contact" },
} as const;

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/privacy"),
    links: siteHeadLinks(blogCss, legalCss),
  }),
  component: PrivacyRoute,
});

function Mail({ address = OPERATOR.email }: { address?: string }) {
  return <a href={`mailto:${address}`}>{address}</a>;
}

function PrivacyRoute() {
  return (
    <LegalPage
      path="/privacy"
      title="Privacy policy"
      updated={LAST_UPDATED}
      updatedIso={LAST_UPDATED_ISO}
      lede={
        <>
          Omnyo runs on your own machines. Your prompts, your code, and your
          files go to the Omnyo server that you run, and from there to the AI
          provider that you choose. This policy explains the data that does
          reach us: from <strong>the Omnyo apps</strong>, from{" "}
          <strong>Omnyo connect</strong>, the optional relay at{" "}
          <code>omnyo.link</code>, and from <strong>this website</strong> at{" "}
          <code>omnyohq.com</code>.
        </>
      }
    >
      <LegalSummary>
        <li>
          Your own server keeps your chats and files. The optional relay carries
          your traffic as described below.
        </li>
        <li>
          Updated Omnyo builds separate a weekly activity count, optional
          product analytics and crash reports. Older installed versions can
          continue sending their earlier data until they update.
        </li>
        <li>
          Omnyo connect is optional. If you use it, we keep your GitHub account
          basics, your servers and devices, and security records. Traffic passes
          through the relay without being recorded.
        </li>
        <li>
          This website asks first. Analytics and error reports run only if you
          allow them, and never when your browser sends Global Privacy Control
          or Do Not Track.
        </li>
        <li>
          We don’t sell your data, use it for advertising, or train AI on it.
        </li>
        <li>
          Questions and requests about your data: <Mail />.
        </li>
      </LegalSummary>

      <LegalContents sections={Object.values(SECTIONS)} />

      <LegalHeading section={SECTIONS.controller} />

      <p>
        {OPERATOR.name}, {OPERATOR.addressLines.join(", ")}, is responsible for
        the processing described here. It is represented by its managing
        director, {OPERATOR.representative}. Write to <Mail /> about this policy
        or your data.
      </p>

      <LegalHeading section={SECTIONS.apps} />

      <p>
        The macOS public beta is intended to keep usage collection and automatic
        crash reports off. Earlier beta packages contained production collector
        configuration; a beta connected to an older host daemon needs that
        daemon updated too. The updated implementation disables these purposes
        across the coordinator, browser and enrolled hosts. Downloading source
        changes does not update an already installed app or host. To find and
        install updates, it downloads them from{" "}
        <a href={GITHUB_URL}>our releases on GitHub</a>, so GitHub receives your
        IP address with each update check. The rest of this section covers
        builds we give out directly.
      </p>

      <p>
        The Omnyo apps are the desktop app, the CLI, and the iOS app (and the
        Android app once it ships). They talk to an Omnyo server that you run.
        We do not operate that server. The usage reports described here do not
        include your prompts, agent conversations, source code, files, terminal
        output or provider API keys. The optional relay carries your traffic
        separately, as described below.
      </p>

      <h3>Reply suggestions</h3>

      <p>
        From Omnyo 1.0.184, Same chat is the default. The agent can write a
        suggestion during its normal turn, and Omnyo saves it on your server.
        Earlier versions use Codex for predictions when the plugin is enabled.
        Choosing Fixed Codex via Account Pooler in 1.0.184 or later also sends
        part of the completed conversation to OpenAI, including prompts and
        replies from chats with other providers. The request in 1.0.184 excludes
        attachment contents and tool output. You can turn Composer predictions
        off in the plugin’s settings.
      </p>

      <h3>Weekly activity count and optional product analytics</h3>

      <p>
        Updated builds offer separate controls under Settings → General →
        Privacy &amp; diagnostics: <strong>Weekly activity count</strong> and
        <strong> Product analytics for this client</strong>. The weekly count
        belongs to your coordinator installation. A successful, human-initiated
        chat or message can attempt one report per UTC week, with no identifier,
        platform, version or message content. Starting the app, automated jobs
        and retries do not qualify. Failed reports are not retried, so the count
        can miss active installations. A shared coordinator counts once; two
        coordinators can count twice. It is not a count of people.
      </p>

      <p>
        The weekly count stays off until you enable it when the region or notice
        is unavailable. Product analytics stays off until you explicitly allow
        it for the browser or CLI client you use. It measures fixed onboarding
        steps, core feature use, operation outcomes and coarse duration buckets,
        and return use with a new random analytics subject. Other clients and
        automated actions do not inherit your grant. It excludes prompts, search
        text, private plugin names, custom provider names, file paths, exact
        system versions and account identifiers. A completed, explicitly
        requested public connector installation can include only the reviewed
        catalog keys listed in the dictionary below. The website never shares
        its data with this subject.
      </p>

      <p>
        A one-time duration bucket measures the time from your explicit
        analytics grant to your first accepted human chat or message. It does
        not measure how long a model takes to answer. Sign-in reports
        distinguish started, accepted, failed and cancelled outcomes. A failed
        sign-in can add one bounded reason: a nonzero exit, a rejected start or
        an unknown cause. These reports omit provider identity and free-form
        error text.
      </p>

      <p>
        Set <code>OMNYO_TELEMETRY=false</code> before startup to disable both
        usage purposes. The CLI also exposes <code>omnyo settings usage</code>
        for status, choices, a payload preview and erasure. Collection needs an
        explicitly configured Omnyo collector; the updated implementation has no
        default external analytics destination. Withdrawal stops new sends and
        discards pending product data. Regranting creates a new subject. You can
        separately request erasure of earlier product events using the client’s
        retained proof, even after withdrawal. Raw product events expire after
        30 days in the new collector. Aggregates cannot be separated back into
        one installation’s contributions.
      </p>

      <p>
        Older builds used a reusable installation ID and sent startup and
        activity events to PostHog, including exact system details. A custom
        provider name could appear in those events, and turning collection off
        sent one final event. These were pseudonymous records, not anonymous
        totals. Existing installations keep that behavior until they update or
        their earlier collection path is disabled. See{" "}
        <a href="#retention">historical retention</a>. Network services see
        connection addresses and timing while carrying reports; we do not claim
        that all production ingress logs retain only totals.
      </p>

      <h3>Crash reports</h3>

      <p>
        Unless you turn it off, the Omnyo app also sends us crash reports when
        something fails in the app, the Omnyo server, or the host daemon that
        runs agents on each machine. A crash report holds the error message and
        stack trace, the app version, which part of Omnyo failed, and the
        runtime version. Reports from the server and the host daemon also name
        your operating system and processor type. Before a report leaves your
        machine, Omnyo replaces the path of your home folder with <code>~</code>{" "}
        and removes credentials it recognizes. Reports carry no request data, no
        account details, and no record of what you did before the error, but an
        error message can still contain a file or project name. The reports go
        to Sentry’s EU region. We use them to find and fix failures in the app
        you use, which is our legitimate interest (§25(2) no. 2 TDDDG with Art.
        6(1)(f) GDPR). To turn them off, go to Settings → General → Privacy
        &amp; diagnostics → Crash reports. The switch covers the app, the server
        and updated host daemons, and a machine remembers its effective policy
        when it restarts. Older daemons may keep their earlier reporting
        behavior until they update; setting <code>OMNYO_SENTRY_DSN</code> to an
        empty value on that machine also stops them.
      </p>

      <h3>Bug reports</h3>

      <p>
        When you use Report a bug, your Omnyo server sends Sentry your note,
        your email address if you add one, the app version, and your operating
        system and processor type. A report sent from the app also links to the
        last crash report the app sent. A bug report holds no chats, logs, or
        screenshots. We use the report to fix the problem and, if you gave an
        email address, to reply to you. We rely on our legitimate interest in
        fixing problems you report and answering you (Art. 6(1)(f) GDPR). Report
        a bug only works while crash reports are on.
      </p>

      <h3>The iOS app</h3>

      <p>
        The iOS app (and the Android app once it ships) stores the following on
        your device:
      </p>
      <ul>
        <li>
          <strong>Server profiles</strong> — the address of each Omnyo server
          you added, and the credential that reaches it. These live in the
          operating system’s secure storage: Keychain on iOS and encrypted
          storage backed by Android Keystore on Android.
        </li>
        <li>
          <strong>Preferences and drafts</strong> — your theme, your list order,
          and unsent message drafts. These live in the app’s own storage.
        </li>
      </ul>

      <p>
        The iOS app (and the Android app once it ships) sends no analytics, no
        telemetry, and no crash reports to us itself. It shows the Omnyo
        interface from your server, and that interface sends crash reports while
        Crash reports is on for that server.
      </p>

      <p>
        The app asks for the camera, the microphone, and the photo library only
        when you attach an image or dictate a prompt. That content goes to your
        Omnyo server. It does not go to us.
      </p>

      <h3>Push notifications</h3>

      <p>
        Push notifications are optional. When you enable them, the mobile app
        registers with Expo and the platform notification service. It sends an
        Expo push token, the platform (iOS or Android), and a device label to
        your Omnyo server. Your server stores that subscription so it can send
        notifications to your device. A push token identifies an app
        installation for delivery; it is not your phone number.
      </p>

      <p>
        Your server sends notifications through Expo Push Service, which
        forwards them to Apple Push Notification service on iOS or Firebase
        Cloud Messaging on Android. The payload includes the push token, thread
        title, notification text, project and thread identifiers, and, when
        available, your server URL so tapping the notification opens the right
        conversation. Notification text can include a short preview of an agent
        question, a command awaiting approval, or an error. Those providers
        process the payload to deliver it, so push notifications are not
        end-to-end encrypted between your server and phone. They are sent
        because you asked for them (Art. 6(1)(b) GDPR).
      </p>

      <p>
        You can turn notifications off in the app’s device settings or your
        phone’s notification settings. Turning them off in the app requests
        removal of the subscription from your server; the server must be
        reachable for that request to succeed. See{" "}
        <a href="https://expo.dev/privacy">Expo’s privacy policy</a>,{" "}
        <a href="https://www.apple.com/legal/privacy/">
          Apple’s privacy policy
        </a>
        , and{" "}
        <a href="https://policies.google.com/privacy">
          Google’s privacy policy
        </a>{" "}
        for their data handling practices.
      </p>

      <LegalHeading section={SECTIONS.connect} />

      <p>
        Omnyo connect is optional. It gives your machine an address such as{" "}
        <code>yourhandle.omnyo.link</code>, so that you can reach it from
        another network. If you only use Omnyo on your own network, you never
        touch it.
      </p>

      <p>When you sign in to Omnyo connect, we store:</p>
      <ul>
        <li>
          Your GitHub account details: name, GitHub login, GitHub user ID, and
          avatar URL. As your email address we store GitHub’s no-reply address
          for your account, not your own address, together with whether GitHub
          reports your email address as verified. GitHub shows us your own
          address during sign-in, and we do not store it. An account created
          before this change keeps the address GitHub reported until its next
          sign-in.
        </li>
        <li>
          The GitHub access token from your sign-in, encrypted. We do not use it
          after sign-in. It stays valid at GitHub until you revoke Omnyo in your
          GitHub settings under Applications.
        </li>
        <li>
          Your Omnyo connect sign-in sessions. A session record holds the IP
          address and the browser details that created it. A session ends after
          7 days without use, and we delete its record within an hour after
          that. We keep at most your 10 newest sessions.
        </li>
        <li>
          A record of each sign-in: the time, your GitHub user ID, and the IP
          address it came from.
        </li>
        <li>
          Your handle, and a record of each server and device you connect: its
          name, its address, when we last saw it, and a hash of its credential.
          We do not store the credential itself. When one of them connects to
          the relay, we record the time and the IP address it connects from, at
          most four addresses per server or device each hour.
        </li>
        <li>
          Pairing codes and link requests, which work once and for 10 minutes. A
          link request also holds the device name it was started with and the IP
          address it came from. We delete both one hour after they expire.
        </li>
        <li>
          A monthly total of how much traffic the relay carries for your
          account.
        </li>
      </ul>

      <p>
        When someone presents a wrong or revoked credential at your address, we
        record the time and their IP address. We keep these records, and the
        records of sign-ins and connections, for up to 90 days, to stop guessing
        attacks and to trace abuse reports to an account. If we suspend or
        delete an account, we record that we did. A separate log of revocations,
        suspensions, deletions and released addresses keeps your relay and
        GitHub user IDs, so that restoring a backup cannot undo them. It drops
        revocations and deletions after 30 days. It keeps the latest record of
        each released address, and the latest suspension or lifted suspension of
        each account, with no time limit.
      </p>

      <p>
        <strong>What the relay can see.</strong> Everything you send through
        your address passes through the relay: the Omnyo app, shared ports, and
        preview links. TLS protects it on the network, but the relay ends that
        TLS connection and opens a second one to your machine, so the relay
        handles the content while it passes. We do not record it and we do not
        store it. Treat the relay as a trusted intermediary, not as end-to-end
        encryption, and do not use it if your threat model forbids that.
      </p>

      <p>
        <strong>What the relay logs.</strong> For each request, the relay logs
        the method, the kind of route, the status, the duration, and the size,
        but not the path or the visitor’s IP address. It also logs when each of
        your servers and devices connects and disconnects, with its address
        name. When the relay refuses a connection that does not come from our
        proxy, it logs the address that connected. The logs stay on the relay
        server until the next update of the relay deletes them.
      </p>

      <p>
        Your own server receives the IP address of each person who opens your
        address, because the relay passes it on. Omnyo connect sets only the
        necessary cookies listed in the <a href="/cookies">cookie policy</a>.
      </p>

      <p>
        We run Omnyo connect to provide the service you signed up for (Art.
        6(1)(b) GDPR). We keep the security records and act on abuse reports
        because of our legitimate interest in keeping the service safe (Art.
        6(1)(f) GDPR).
      </p>

      <p>
        You can revoke any server or device at any time from your dashboard at{" "}
        <code>omnyo.link</code>. Revoking it ends its access immediately. To
        report abuse from an address under <code>omnyo.link</code>, see{" "}
        <a href="/abuse">Report abuse</a>.
      </p>

      <LegalHeading section={SECTIONS.workflows} />

      <p>
        When you share a workflow, Omnyo connect stores the workflow file you
        upload under your account, with its title, its description and the
        permissions it asks for. Its reviewed package and preview are public to
        anyone with the link, so only share what you are happy to make public.
        Links expire after 30 days by default, with a maximum of 90 days. After
        a link expires, the relay stops serving it at once and deletes its file
        in its regular cleanup. Revoking a link or deleting its account prevents
        new downloads; copies already downloaded remain with recipients. Deleted
        bytes may remain in earlier backups until those backups expire, but
        restore-time revocation prevents serving them again. We store the file
        to provide the sharing you asked for (Art. 6(1)(b) GDPR). The share page
        at <code>omnyohq.com/w/…</code> loads no scripts, sets no cookies and
        runs no analytics.
      </p>

      <LegalHeading section={SECTIONS.website} />

      <h3>Every visit</h3>

      <p>
        This website runs on our own server at Hetzner in Germany. To send you a
        page, the server processes your IP address, the address of the page, and
        the details your browser sends with each request, such as its browser
        and language. Hosting, ingress and security systems can also process
        connection metadata. Their complete retention has not been verified; the
        application’s usage counter does not store individual requests. We rely
        on our legitimate interest in delivering a working, secure website (Art.
        6(1)(f) GDPR). The <code>omnyo explore</code> command reads the public
        catalog from this website in the same way.
      </p>

      <p>
        Fonts, images and scripts all come from <code>omnyohq.com</code> itself,
        and the site asks for no account or email address. If you type{" "}
        <code>www.omnyohq.com</code>, Cloudflare receives that request and
        redirects you here. Cloudflare may ask your browser to report failed
        connections to <code>www.omnyohq.com</code> back to Cloudflare for up to
        7 days. To show the right download button and colors, the page checks
        your operating system, screen type and light or dark setting inside your
        browser; that check stores nothing and sends nothing to us.
      </p>

      <h3>Your choice about cookies</h3>

      <p>
        On your first visit, a banner asks whether you allow two optional
        purposes: <strong>Usage analytics</strong> and{" "}
        <strong>Error reports</strong>. Until you choose, the site sets no
        cookies and loads neither. We ask every visitor, wherever they are. You
        can accept all, reject all, or choose each purpose, and the site works
        the same either way. Two necessary cookies remember your answer for{" "}
        {CONSENT_DAYS} days; after that we ask again. To change or withdraw your
        choice at any time, use <CookieSettingsLink /> at the bottom of every
        page. Withdrawing stops collection at once and does not affect what was
        collected before. The <a href="/cookies">cookie policy</a> lists every
        cookie and storage key.
      </p>

      <p>
        If your browser sends a Global Privacy Control (<code>Sec-GPC: 1</code>)
        or Do Not Track (<code>DNT: 1</code>) signal, we treat it as your
        objection. The banner then stays closed, and both purposes stay off even
        if you accept them.
      </p>

      <h3>Usage analytics, if you allow it</h3>

      <p>
        With Usage analytics on, this website can send the fixed events listed
        below to our own website server. That server forwards only validated
        event fields to an explicitly configured Omnyo collector. Until the
        collector is configured, no new usage stream is collected. The collector
        increments a total for the UTC day and event category; it stores no raw
        website events or visitor identifier. These are counts of actions, not
        unique visitors or completed installations, and we do not use them as
        public popularity figures.
      </p>

      <p>
        There is no session recording, DOM capture, heatmap, visitor ID,
        campaign attribution, or tracking of individual journeys. Searches
        transmit only a range for the number of results, never the words you
        type. Page views use fixed section names, never URLs or query strings.
        Listing events describe a kind of listing, not its name or identifier.
        The forwarding request carries no visitor IP address, browser details,
        cookie or referrer. Connection addresses and timing remain visible to
        the network services carrying it; this does not establish an
        aggregate-only logging policy for every production hop. We rely on your
        consent (§25(1) TDDDG, Art. 6(1)(a) GDPR).
      </p>

      <h3>Error reports, if you allow them</h3>

      <p>
        With Error reports on, your browser sends Sentry a report when a script
        on this site fails. A report holds the type of error and its message,
        with web addresses shortened and anything that looks like an email
        address or a token removed; the place in our own code where it failed;
        which part of the site you were on, such as “guides”; and the name and
        major version of your browser and the name of your operating system. It
        holds no cookies, no full page address, no record of your earlier
        clicks, no screen recording and no user details, and we send at most 10
        reports per page. Your browser sends the report straight to Sentry’s EU
        region in Germany, so Sentry sees your IP address with the connection;
        we do not add it to the report, and our Sentry project is set not to
        store IP addresses. We rely on your consent (§25(1) TDDDG, Art. 6(1)(a)
        GDPR).
      </p>

      <h3>Errors on our server</h3>

      <p>
        When the website’s own server fails, it sends Sentry a report with the
        error, the place in our code where it failed, which part of the site was
        requested, such as “guides”, and the server’s Node.js version. These
        reports contain no IP addresses, cookies, request contents or other
        details about visitors, and they do not touch your device, so they do
        not depend on your cookie choice. We rely on our legitimate interest in
        keeping the site working (Art. 6(1)(f) GDPR).
      </p>

      <h3>Downloads and GitHub</h3>

      <p>
        The macOS download and its updates are hosted on GitHub. When you
        download Omnyo or follow a link to GitHub, your browser connects to
        GitHub, Inc. in the United States, which receives your IP address and
        browser details and handles them under the{" "}
        <a href={GITHUB_PRIVACY_URL}>GitHub Privacy Statement</a>.
      </p>

      <LegalHeading section={SECTIONS.dictionary} />

      <h3>Updated app builds</h3>
      <p>
        An enabled weekly count sends one empty{" "}
        <code>POST /metrics/active-week</code>
        request per attempted active week. The recipient adds one to that UTC
        week’s counter; the body contains no fields. Optional product analytics
        uses <code>/metrics/product</code>. Each report adds an analytics-only
        subject, a UTC day and a cumulative count from 1 to 100 for that
        subject, day, event and property combination. Daily activity is capped
        at one. The subject is a hash of the random client grant, with no
        account, machine, provider or website identifier as an input. These raw
        records expire after 30 UTC calendar days. Long-lived product rollups
        require at least 10 contributing subjects for the group; smaller groups
        are not retained in those rollups. Return-use cohorts are calculated
        only after their measurement window has matured. The erasure control
        uses
        <code> /metrics/product-erasure</code> with a possession proof,
        independently of collection consent; it sends no analytics
        acknowledgement event. To stop already in-flight deliveries restoring
        erased data, the collector retains a one-way, domain-separated
        revocation digest for up to 30 days. It does not retain the proof
        itself.
      </p>
      <p>
        Product counters are combined locally and sent at fixed UTC hour
        boundaries. There is no per-action, page-close or shutdown flush. Unsent
        batches are discarded on withdrawal or shutdown, and failed or stale
        batches are not retried, so observations can be missed. The weekly count
        and an explicit erasure request are sent when triggered, separately from
        these hourly product batches.
      </p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Purpose</th>
            <th>Allowed fields</th>
          </tr>
        </thead>
        <tbody>
          {PRODUCT_USAGE_DICTIONARY.map((entry) => (
            <tr key={entry.name}>
              <td>
                <code>{entry.name}</code>
              </td>
              <td>{entry.purpose}</td>
              <td>{entry.fields}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        A synthetic product event before its subject, UTC day and cumulative
        count are added:
      </p>
      <pre>
        <code>
          {JSON.stringify(PRODUCT_USAGE_DICTIONARY[3]?.example, null, 2)}
        </code>
      </pre>

      <h3>This website</h3>
      <p>
        This dictionary describes the updated website event format. Every event
        requires a current Usage analytics grant and no browser objection.
        Unknown event names or extra fields are rejected. All events have the
        same destination: the website’s first-party{" "}
        <code>/api/usage/event</code>
        route and, only when configured, the Omnyo collector’s
        <code> /metrics/site-events</code> route. The collector retains UTC-day
        category totals with no visitor or event-level records. No website
        identity exists to join with an app, account, Sentry report or relay
        record.
      </p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Purpose and trigger</th>
            <th>Allowed fields</th>
          </tr>
        </thead>
        <tbody>
          {SITE_USAGE_DICTIONARY.map((entry) => (
            <tr key={entry.name}>
              <td>
                <code>{entry.name}</code>
              </td>
              <td>{entry.purpose}</td>
              <td>{entry.fields}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>A complete example request body, with no hidden SDK fields:</p>
      <pre>
        <code>
          {JSON.stringify(
            { event: { name: "marketplace_results", count: "1-5" } },
            null,
            2,
          )}
        </code>
      </pre>
      <p>
        Withdrawing your choice stops future requests and cancels pending
        browser requests; it cannot recall a completed request. The resulting
        totals have no identifier with which to find or erase one visitor’s
        contribution. This differs from identifiable historical PostHog records
        described below.
      </p>

      <LegalHeading section={SECTIONS.email} />

      <p>
        Email to <Mail /> or <Mail address={ABUSE_EMAIL} /> passes through
        Cloudflare Email Routing, which forwards it to our mailbox at Proton in
        Switzerland. We use your address and your message only to answer you and
        to act on your report. We rely on our legitimate interest in answering
        you (Art. 6(1)(f) GDPR) or, for a request about your data, on our legal
        duty to answer it (Art. 6(1)(c) GDPR). We keep the email only as long as
        we need it for that.
      </p>

      <LegalHeading section={SECTIONS.providers} />

      <h3>Processors working for us</h3>

      <p>
        These companies process data on our behalf under a data processing
        agreement, each only for the job named here:
      </p>
      <ul>
        <li>
          <strong>PostHog</strong> (PostHog, Inc.) holds earlier pseudonymous
          website and app events in its EU cloud. Older installed builds can
          still send there. The updated website no longer sends to PostHog.
        </li>
        <li>
          <strong>Sentry</strong> (Functional Software, Inc.) receives crash
          reports and bug reports from the app, and error reports from this
          website, in its EU region in Germany.
        </li>
        <li>
          <strong>Hetzner Online</strong> hosts this website, the relay and the
          relay’s backups on servers in Germany.
        </li>
        <li>
          <strong>Cloudflare</strong> answers DNS for <code>omnyo.link</code>{" "}
          and <code>omnyohq.com</code>, redirects <code>www.omnyohq.com</code>{" "}
          to this website, and forwards email sent to our addresses. Relay and
          website traffic does not pass through Cloudflare.
        </li>
        <li>
          <strong>Proton</strong> (Proton AG, Switzerland) hosts the mailbox
          that Cloudflare forwards email for <Mail /> and{" "}
          <Mail address={ABUSE_EMAIL} /> to.
        </li>
      </ul>

      <h3>Companies acting under their own policies</h3>

      <p>
        These companies receive data as independent controllers and handle it
        under their own privacy policies:
      </p>
      <ul>
        <li>
          <strong>GitHub</strong> handles sign-in to Omnyo connect, hosts the
          macOS download, and answers the macOS beta’s update checks.
        </li>
        <li>
          <strong>Expo, Apple and Google</strong> deliver push notifications
          when you enable them.
        </li>
      </ul>

      <h3>Transfers outside the EU</h3>

      <p>
        PostHog, Sentry, Cloudflare, GitHub, Expo, Apple and Google are based in
        the United States or belong to US groups, so they may process data
        outside the EU even where we chose EU storage. Where one of our
        processors moves data outside the EU or the EEA, we rely on the EU–US
        Data Privacy Framework for providers certified under it, and otherwise
        on the European Commission’s standard contractual clauses in our
        agreement with them. Write to <Mail /> for a copy. GitHub, Expo, Apple
        and Google decide how they transfer data under their own policies.
        Proton is in Switzerland, which the European Commission recognizes as
        protecting personal data adequately.
      </p>

      <LegalHeading section={SECTIONS.retention} />

      <h3>Omnyo connect</h3>

      <p>
        We keep your Omnyo connect account data until you ask us to delete the
        account. Sessions, pairing codes, and link requests are deleted as
        described above, and records of sign-ins, connections, and refused
        credentials after at most 90 days. A device you revoke is deleted 30
        days later. We delete an account that is more than 30 days old and has
        no address, server, device, active session, or unexpired shared workflow
        link. To delete your account, write to <Mail />. We then remove your
        account record, your sessions, your servers and devices, your shared
        workflow links, and your handle.
      </p>

      <p>
        After deletion we keep the address names your account used, with your
        GitHub user ID, so that nobody else can take them over. If we suspended
        the account, we keep that record with your GitHub user ID, so that the
        suspension still applies if you sign up again. Records of your sign-ins
        and connections, with their IP addresses and your GitHub user ID, stay
        until they are 90 days old.
      </p>

      <p>
        Deleted data stays in our backups for about 14 more days. The relay
        copies its database every night and keeps the 7 newest copies. The
        server archives those copies every night and keeps the 7 newest
        archives. If a nightly copy or archive fails, the oldest one stays until
        the next one succeeds, so this can take longer.
      </p>

      <h3>New collection and historical records</h3>

      <p>
        The new collector expires raw pseudonymous product events after 30 days.
        Weekly activity reports and website events become counters rather than
        retained individual records. This describes the new collector’s storage,
        not a verified retention promise for every production ingress, backup or
        export. New streams stay disabled without explicit collector
        configuration.
      </p>

      <p>
        Earlier PostHog app and website events used reusable random IDs. The
        last reviewed project setting retained raw events for{" "}
        {LEGACY_POSTHOG_EVENT_RETENTION} and session replays for{" "}
        {LEGACY_REPLAY_RETENTION_DAYS} days. This source update does not erase
        those records or verify deletion from exports and backups. Their
        disposition remains separate from stopping collection. Sentry keeps
        crash reports, bug reports and error reports for at most{" "}
        {SENTRY_RETENTION_DAYS} days. Ask us about identifiable historical data;
        do not send us a password, API token or conversation as proof.
      </p>

      <h3>The Omnyo apps</h3>

      <p>
        Data held by the Omnyo apps is yours. Deleting the iOS app (or the
        Android app once it ships) removes its local preferences and drafts from
        the device.
      </p>

      <LegalHeading section={SECTIONS.rights} />

      <p>
        You can ask us for a copy of your data, and to correct it, delete it,
        restrict its use, or hand it to you in a portable format. Where we rely
        on your consent, you can withdraw it at any time, on this website with{" "}
        <CookieSettingsLink />; this does not affect processing before you
        withdrew. Write to <Mail />.
      </p>

      <p>
        You don’t have to give us any data. Without a GitHub sign-in you cannot
        use Omnyo connect, and without an email address we cannot reply to you.
        Everything else on this website works without either.
      </p>

      <p>
        <strong>Your right to object.</strong> You can object at any time to
        processing that relies on our legitimate interest, for reasons that
        arise from your situation. In the app, the switches under Settings →
        General → Privacy &amp; diagnostics stop usage events and crash reports
        at once. On this website, a Global Privacy Control or Do Not Track
        signal counts as your objection. For anything else, write to us.
      </p>

      <p>
        Historical PostHog events carried a random identifier: earlier website
        cookies and older installations’ <code>telemetry-id</code> files may
        help identify those records if you still have them. Updated clients
        retire the old installation ID. New product analytics uses separate
        possession proof for erasure. New website totals contain no visitor
        identifier; we cannot identify one visitor’s contribution to erase it.
      </p>

      <p>
        You can also complain to a data protection authority, such as the one
        where you live or the one responsible for us: the{" "}
        <a href={COMPLAINT_URL}>
          Landesbeauftragte für Datenschutz und Informationsfreiheit
          Nordrhein-Westfalen
        </a>
        .
      </p>

      <LegalHeading section={SECTIONS.limits} />
      <ul>
        <li>
          We do not sell your data or share it for advertising, including
          cross-context behavioral advertising as California law defines it.
        </li>
        <li>
          We use no advertising cookies, tracking pixels or social media
          plugins.
        </li>
        <li>
          We do not read, store, or train on your prompts, your code, or your
          agent conversations.
        </li>
        <li>
          We make no automated decisions about you that have legal or similarly
          significant effects.
        </li>
      </ul>

      <LegalHeading section={SECTIONS.children} />

      <p>
        Omnyo is a developer tool. It is not directed at children under 16, and
        we do not knowingly collect their data.
      </p>

      <LegalHeading section={SECTIONS.changes} />

      <p>
        We will update this page when the product changes, and we will move the
        date at the top.
      </p>

      <LegalHeading section={SECTIONS.contact} />

      <p>
        {OPERATOR.name}, {OPERATOR.addressLines.join(", ")}. <Mail />. Report
        abuse or a security problem in Omnyo connect to{" "}
        <Mail address={ABUSE_EMAIL} />. See also the{" "}
        <a href="/imprint">imprint</a>.
      </p>
    </LegalPage>
  );
}
