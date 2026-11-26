import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkflowNavigation } from "../workflow-catalog/navigation";
import { guideMenu } from "./content-links";
import { GITHUB_URL, MACOS_DOWNLOAD_URL, REPO_URL } from "./site";
import { SiteFooter, SiteNav } from "./site-chrome";

const DROPPED_LINKS = [
  'href="/marketplace',
  'href="/blog',
  'href="/changelog',
  'href="/compare',
  'href="/dashboard',
  'href="/download',
  'href="/brand',
  'href="/uninstall',
  "getbb.app",
];

const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]+)"/gu)].map((match) => match[1]);

const section = (html: string, className: string) => {
  const start = html.indexOf(`class="${className}"`);
  const end = html.indexOf("</nav>", start);

  return html.slice(start, end);
};

describe("site navigation", () => {
  const guideHrefs = guideMenu().flatMap((item) =>
    "links" in item ? item.links.map((link) => link.href) : [item.href],
  );

  it("links features, every guide, the Plugin Guide, GitHub and the macOS download", () => {
    const html = renderToStaticMarkup(<SiteNav />);

    for (const menu of ["site-nav-links", "site-nav-sheet"]) {
      expect(hrefs(section(html, menu))).toEqual(
        menu === "site-nav-links"
          ? ["/features", ...guideHrefs, "/plugin-guide", REPO_URL]
          : ["/features", "/plugin-guide", ...guideHrefs, GITHUB_URL],
      );
    }

    expect(html).toContain(`href="${MACOS_DOWNLOAD_URL}"`);
    expect(html).toContain("Download for Mac");
    expect(html).not.toContain("site-nav-cta");
    expect(html).not.toContain('href="#download"');
    expect(html).not.toMatch(/<a (?![^>]*href=)/u);

    expect(html).not.toMatch(/beta/iu);

    for (const dropped of DROPPED_LINKS) {
      expect(html).not.toContain(dropped);
    }
  });

  it("adds Workflows when the catalog is published", () => {
    const html = renderToStaticMarkup(
      <WorkflowNavigation.Provider value>
        <SiteNav current="workflows" path="/workflows" />
      </WorkflowNavigation.Provider>,
    );

    expect(hrefs(section(html, "site-nav-links"))).toEqual([
      "/features",
      ...guideHrefs,
      "/workflows",
      "/plugin-guide",
      REPO_URL,
    ]);
    expect(html).toContain(
      'class="is-current" href="/workflows" aria-current="page">Workflows',
    );
  });

  it("marks the current section and page", () => {
    const html = renderToStaticMarkup(
      <SiteNav current="plugin-guide" path="/plugin-guide" />,
    );

    expect(html).toContain(
      'class="is-current" href="/plugin-guide" aria-current="page">Plugin Guide',
    );

    const guide = guideHrefs[0] ?? "";

    const onGuide = renderToStaticMarkup(
      <SiteNav current="guides" path={guide} />,
    );

    expect(onGuide).toContain('<summary class="is-current">Guides');
    expect(onGuide).toContain(`href="${guide}" aria-current="page"`);
  });
});

describe("site footer", () => {
  it("credits bb and links only pages the site serves", () => {
    const footer = renderToStaticMarkup(<SiteFooter current="/privacy" />);

    expect(footer).toContain('href="https://github.com/get-bb/bb">bb</a>');
    expect(footer).toContain("(MIT License)");
    expect(footer).not.toContain("original authors");
    expect(footer).toMatch(/© \d{4} Omnyo/u);
    expect(footer).toContain('href="/privacy" aria-current="page">Privacy');
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/imprint"');
    expect(footer).toContain('href="/cookies"');
    expect(footer).toContain(`href="${GITHUB_URL}"`);
    expect(footer).toContain(`href="${MACOS_DOWNLOAD_URL}">Download for Mac`);
    expect(footer).toMatch(
      /<button type="button" class="site-footer-button" data-cookie-settings="true">Cookie settings<\/button>/u,
    );
    expect(footer).not.toContain("iubenda");
    expect(footer).not.toMatch(/open source/iu);

    for (const title of ["Product", "Guides"]) {
      expect(footer).toContain(`<h2 class="footer-title">${title}</h2>`);
    }

    for (const dropped of DROPPED_LINKS) {
      expect(footer).not.toContain(dropped);
    }
  });
});
