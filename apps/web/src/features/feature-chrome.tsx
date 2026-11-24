import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./features.css";

import type { ReactNode } from "react";

import { comparisonMetas, comparisonPath } from "../compare/comparisons";
import { DownloadButton, DownloadPanel } from "../landing/download";
import { SWITCH_GUIDES, TOPIC_GUIDES } from "../landing/site-links";
import { BB_URL, GITHUB_URL } from "../landing/site";
import {
  OmnyoMark,
  SiteNavLinks,
  SiteNavMenu,
  type SiteSection,
} from "../landing/site-chrome";
import { ThemeToggle } from "../landing/theme-toggle";
import { featureGroups } from "./features";

function FeatureNav({ current }: { current?: SiteSection }) {
  return (
    <header className="fx-nav">
      <a className="fx-brand" href="/" aria-label="Omnyo home">
        <OmnyoMark className="fx-brand-mark" />
        <span>Omnyo</span>
      </a>
      <SiteNavLinks current={current} />
      <ThemeToggle />
      <DownloadButton />
      <SiteNavMenu />
    </header>
  );
}

export function FeatureClosing() {
  return (
    <section className="fx-closing" id="download">
      <OmnyoMark className="fx-closing-mark" />
      <h2>Close the other terminals.</h2>
      <p>Every agent, branch and preview in one window, on any device.</p>
      <DownloadPanel />
    </section>
  );
}

function FeatureFooter() {
  return (
    <footer className="fx-foot">
      <div className="fx-foot-top">
        <div className="fx-foot-brand">
          <OmnyoMark className="fx-foot-mark" />
          <p>The unified interface for coding agents.</p>
        </div>
        <nav className="fx-foot-cols" aria-label="Footer">
          {featureGroups().map((entry) => (
            <div key={entry.group}>
              <p className="fx-foot-head">{entry.group}</p>
              {entry.features.map((feature) => (
                <a href={`/features/${feature.slug}`} key={feature.slug}>
                  {feature.name}
                </a>
              ))}
            </div>
          ))}
          <div>
            <p className="fx-foot-head">Guides</p>
            {comparisonMetas().map((comparison) => (
              <a href={comparisonPath(comparison.slug)} key={comparison.slug}>
                {comparison.name}
              </a>
            ))}
            {TOPIC_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="fx-foot-head">Switch to Omnyo</p>
            {SWITCH_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                From {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="fx-foot-head">Legal</p>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/imprint">Imprint</a>
            <a href="/cookies">Cookies</a>
            <button
              type="button"
              data-cookie-settings
              className="fx-foot-button"
            >
              Cookie settings
            </button>
          </div>
        </nav>
      </div>
      <div className="fx-foot-bottom">
        <span>
          Built on <a href={BB_URL}>bb</a> (MIT License)
        </span>
        <a href={GITHUB_URL}>Releases</a>
        <span>© 2026 Omnyo</span>
      </div>
    </footer>
  );
}

export function FeatureShell({
  children,
  current,
}: {
  children: ReactNode;
  current?: SiteSection;
}) {
  return (
    <div className="fx">
      <FeatureNav current={current} />
      <main>{children}</main>
      <FeatureFooter />
    </div>
  );
}
