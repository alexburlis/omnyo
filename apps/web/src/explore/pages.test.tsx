import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { MACOS_DOWNLOAD_URL } from "../landing/site";
import { Route as CatalogJsonRoute } from "../routes/explore.catalog[.]json";
import { Route as PromptTextRoute } from "../routes/explore.prompts.$slug_.text";
import { GuidePage } from "../guides/guide-page";
import { getGuide } from "../guides/guides";
import { WorkflowListing } from "../workflow-catalog/WorkflowListing";
import { workflowCatalog } from "../workflow-catalog/entries.server";
import { WorkflowNavigation } from "../workflow-catalog/navigation";
import { ExploreIndex } from "./ExploreIndex";
import { ExplorePluginPage } from "./ExplorePluginPage";
import { ExplorePromptPage } from "./ExplorePromptPage";
import { ExploreSkillPage } from "./ExploreSkillPage";
import { marketplaceDetail } from "./marketplace-detail.server";
import { marketplaceActions } from "./marketplace-view";
import {
  MarketplaceDetailPage,
  OPEN_IN_OMNYO_REQUIREMENT,
} from "./MarketplaceDetailPage";
import { publicSkills } from "./public-skill-catalog.server";
import { exploreActivation } from "./activation.server";
import { createExploreCatalog } from "./catalog.server";
import { exploreOwners } from "./entries.server";
import { ExploreNavigation } from "./navigation";
import { exploreRecords } from "./records.server";

const catalog = createExploreCatalog({
  activation: "active",
  records: exploreRecords,
  owners: exploreOwners,
});

const cardHrefs = (html: string) =>
  [...html.matchAll(/class="ex-(?:card|featured)" href="([^"]+)"/gu)].map(
    ([, href]) => href,
  );

it("finds Customer Lab in the Marketplace and serves its cited six-skill pack", async () => {
  const listing = marketplaceDetail("skill", "customer-lab");
  const detail = catalog.skillDetail("customer-lab");
  const paper = "https://arxiv.org/pdf/2510.08338";

  if (!listing || !detail) throw new Error("Customer Lab is missing");

  expect(marketplaceActions(listing.item)[0]).toEqual({
    label: "Get the skill pack",
    href: detail.item.path,
  });
  expect(
    renderToStaticMarkup(<MarketplaceDetailPage {...listing} />),
  ).toContain(`href="${paper}"`);
  expect(renderToStaticMarkup(<ExploreSkillPage {...detail} />)).toContain(
    `href="${paper}"`,
  );

  const response = catalog.skillFileResponse(
    "customer-lab",
    detail.release.sha256,
  );

  expect(response.status).toBe(200);

  const pack = await response.json();
  expect(pack.skills.map(({ id }: { id: string }) => id)).toEqual([
    "customer-lab",
    "landing-page-tester",
    "onboarding-tester",
    "product-workflow-tester",
    "developer-adoption-tester",
    "buyer-offer-panel",
  ]);
  expect(pack.skills[0].files[0].content).toContain(paper);
  expect(pack.skills[5].files[0].content).toContain(paper);
});

function withNavigation(
  node: React.ReactNode,
  { workflows, explore }: { workflows: boolean; explore: boolean },
) {
  return renderToStaticMarkup(
    <WorkflowNavigation.Provider value={workflows}>
      <ExploreNavigation.Provider value={explore}>
        {node}
      </ExploreNavigation.Provider>
    </WorkflowNavigation.Provider>,
  );
}

describe("Explore index", () => {
  it("features the first item and lists the rest with type filters", () => {
    const html = renderToStaticMarkup(
      <ExploreIndex items={catalog.items} search={{}} />,
    );

    expect(cardHrefs(html)).toEqual(catalog.items.map(({ path }) => path));
    expect(html).toContain(
      'class="ex-featured" href="/workflows/weekly-content-feed"',
    );
    expect(html).toContain('src="/workflows/weekly-content-feed/preview.png"');

    for (const href of [
      "/explore",
      "/explore?type=prompt",
      "/explore?type=workflow",
      "/explore?type=skill",
      "/explore?type=plugin",
      "/explore?type=guide",
    ])
      expect(html).toContain(`href="${href}"`);

    expect(html).toContain('action="/explore"');
    expect(html).toContain('maxLength="80"');
    expect(html).not.toContain("data-explore-empty");
  });

  it("filters without a featured card and keeps the query in type links", () => {
    const html = renderToStaticMarkup(
      <ExploreIndex
        items={catalog.items}
        search={{ type: "prompt", q: "review" }}
      />,
    );

    expect(cardHrefs(html)).toEqual([
      "/explore/prompts/review-a-product-update",
    ]);
    expect(html).not.toContain('href="/explore/plugins/browser-automation"');
    expect(html).toContain('href="/explore?type=plugin&amp;q=review"');
    expect(html).toContain('name="type" value="prompt"');
    expect(html).toContain('value="review"');
  });

  it("offers a clear-filters action when nothing matches", () => {
    const html = renderToStaticMarkup(
      <ExploreIndex
        items={catalog.items}
        search={{ q: "zz-no-explore-match" }}
      />,
    );

    expect(cardHrefs(html)).toEqual([]);
    expect(html).toContain('data-explore-empty=""');
    expect(html).toMatch(
      /<a class="btn btn-ghost" href="\/explore">Clear filters<\/a>/u,
    );
  });
});

describe("Explore details", () => {
  it("opens the pinned Marketplace Markdown in Skills and retains the source link", () => {
    const skill = publicSkills.find(
      ({ source, setupUrl }) => source === "github" && setupUrl === undefined,
    );

    if (!skill) throw new Error("Missing a public skill listing");
    const detail = marketplaceDetail("skill", skill.slug);

    if (!detail) throw new Error("Missing the skill detail");
    const markup = renderToStaticMarkup(<MarketplaceDetailPage {...detail} />);

    expect(markup).toContain(
      `href="omnyo://skills/source/${skill.slug}/${skill.sha256}"`,
    );
    expect(markup).toContain(`href="${skill.sourceUrl}"`);
    expect(markup).toContain(OPEN_IN_OMNYO_REQUIREMENT);
    expect(detail.preview).toBeNull();
    expect(detail.related.length).toBeGreaterThan(0);
    expect(
      detail.related.every(
        (item) => item.category === skill.category && item !== detail.item,
      ),
    ).toBe(true);
  });

  it("links Poteto Mode to pstack setup", () => {
    const detail = marketplaceDetail("skill", "poteto-mode");

    if (detail?.item.kind !== "skill") throw new Error("Missing Poteto Mode");

    const markup = renderToStaticMarkup(<MarketplaceDetailPage {...detail} />);

    expect(markup).toContain(`href="${detail.item.setupUrl}"`);
    expect(markup).toContain("Setup instructions");
    expect(markup).toContain("Install the full pstack plugin");
    expect(markup).not.toContain("omnyo://skills/source/poteto-mode/");
  });

  it("previews an Omnyo edition's SKILL.md and offers the versioned download", () => {
    const detail = marketplaceDetail("skill", "web-font-optimization");

    if (!detail || detail.item.kind !== "skill")
      throw new Error("Missing the edition");
    const markup = renderToStaticMarkup(<MarketplaceDetailPage {...detail} />);

    expect(detail.preview?.lines[0]).toBe("# Web Font Optimization");
    expect(detail.preview?.lines.some((line) => line.startsWith("name:"))).toBe(
      false,
    );
    expect(markup).toContain(
      'href="/skills/omnyo/web-font-optimization/1.0.0/SKILL.md" download="SKILL.md"',
    );
  });

  it("gives connectors their own icon and a working setup anchor", () => {
    const detail = marketplaceDetail("connector", "workspace-github");

    if (!detail) throw new Error("Missing the connector");
    const markup = renderToStaticMarkup(<MarketplaceDetailPage {...detail} />);

    expect(markup).toContain('id="find-in-omnyo"');
    expect(markup).toContain('href="#find-in-omnyo"');
    expect(markup).not.toContain('class="mk-glyph"');
    expect(marketplaceDetail("connector", "missing")).toBeNull();
  });

  it("offers the same pinned skill pack through the desktop handoff and file link", () => {
    const detail = catalog.skillDetail("product-update-review");

    if (!detail) throw new Error("Missing skill pack");

    const markup = renderToStaticMarkup(<ExploreSkillPage {...detail} />);
    const { sha256 } = detail.release;

    expect(markup).toContain(
      `omnyo://skills/import/product-update-review/${sha256}`,
    );
    expect(markup).toContain(
      `/explore/skills/product-update-review/file/${sha256}`,
    );
    expect(markup).toContain("check-release-claims");
    expect(markup).toContain("Review this release draft");
    expect(markup).toContain("Version 1.0.0");
  });

  it("renders the complete prompt without JavaScript and marks placeholders", () => {
    const detail = catalog.promptDetail("review-a-product-update");

    if (!detail) throw new Error("Missing prompt");

    const html = renderToStaticMarkup(<ExplorePromptPage {...detail} />);

    const code = /<pre class="ex-prompt"><code>([\s\S]*?)<\/code><\/pre>/u.exec(
      html,
    )?.[1];

    const visibleText = code
      ?.replace(/<\/?mark>/gu, "")
      .replace(/&quot;/gu, '"')
      .replace(/&#x27;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&");

    expect(visibleText).toBe(detail.prompt.body);
    expect(html).toContain("<mark>{{product name}}</mark>");
    expect(html).toContain(
      'href="/explore/prompts/review-a-product-update/text"',
    );
    expect(html).toContain("Copy prompt");
    expect(html).toContain("Fictional example");
    expect(html).toContain('href="/workflows/weekly-content-feed"');
    expect(html).toContain('class="ex-status" role="status"></p>');
  });

  it("explains how to find the included plugin and its qualified install", () => {
    const detail = catalog.pluginDetail("browser-automation");

    if (!detail) throw new Error("Missing plugin");

    const html = renderToStaticMarkup(<ExplorePluginPage {...detail} />);

    expect(html).toContain("Plugin · By bb · Omnyo Official");
    expect(html).toContain('href="#find-in-omnyo"');
    expect(html).toContain('id="find-in-omnyo"');
    expect(html).toContain(
      "<code>omnyo plugin install browser-automation@omnyo-official</code>",
    );
    expect(html).toContain("Plugins, then Installed plugins");
    expect(html).toContain('href="https://github.com/get-bb"');
    expect(html).toContain("Included with Omnyo for Mac");
    expect(
      new Set(
        [...html.matchAll(/href="([^"]+\.(?:zip|tgz|dmg|tar\.gz))"/gu)].map(
          ([, href]) => href,
        ),
      ),
    ).toEqual(new Set([MACOS_DOWNLOAD_URL]));
  });
});

describe("Explore navigation", () => {
  it("adds Explore to the header and keeps Workflows in the footer", () => {
    const nav = withNavigation(
      <SiteNav current="workflows" path="/workflows" />,
      {
        workflows: true,
        explore: true,
      },
    );

    const footer = withNavigation(<SiteFooter current="/explore" />, {
      workflows: true,
      explore: true,
    });

    expect(nav).toContain('class="is-current" href="/explore"');
    expect(nav).not.toContain('href="/workflows"');
    expect(nav).toContain('href="/plugin-guide"');
    expect(footer).toContain('href="/explore" aria-current="page"');
    expect(footer).toContain('href="/workflows"');
  });

  it("leaves the inactive navigation unchanged", () => {
    const nav = withNavigation(<SiteNav />, {
      workflows: true,
      explore: false,
    });

    const footer = withNavigation(<SiteFooter />, {
      workflows: true,
      explore: false,
    });

    expect(nav).toContain('href="/workflows"');
    expect(nav).not.toContain('href="/explore"');
    expect(footer).not.toContain('href="/explore"');
    expect(footer).not.toContain('href="/workflows"');
  });
});

describe("Explore cross-links on existing pages", () => {
  const guide = getGuide("run-an-agent-on-a-schedule");
  const workflow = workflowCatalog.detail("weekly-content-feed");

  if (!guide || !workflow) throw new Error("Missing seed owners");

  it("adds the next step and guide Copy link only while Explore is active", () => {
    const on = withNavigation(
      <GuidePage
        guide={guide}
        related={catalog.relatedFor("guide", guide.slug)}
      />,
      { workflows: true, explore: true },
    );

    const off = withNavigation(<GuidePage guide={guide} related={[]} />, {
      workflows: true,
      explore: false,
    });

    expect(on).toContain("Copy link");
    expect(on).toContain('id="ex-related-heading"');
    expect(on).toContain('href="/workflows/weekly-content-feed"');
    expect(off).not.toContain("Copy link");
    expect(off).not.toContain("ex-related");
    expect(off).not.toContain("gd-hero-actions--share");
  });

  it("links the workflow to its guide without changing the inactive page", () => {
    const on = renderToStaticMarkup(
      <WorkflowListing
        {...workflow}
        related={catalog.relatedFor("workflow", "weekly-content-feed")}
      />,
    );

    const off = renderToStaticMarkup(
      <WorkflowListing {...workflow} related={[]} />,
    );

    expect(on).toContain(
      `href="omnyo://workflows/import/${workflow.release.sha256.slice(0, 32)}">Open in Omnyo`,
    );
    expect(on).toContain(
      'class="wf-get" href="/downloads/Omnyo-Weekly-Content-Feed-Setup.zip" download=""',
    );
    expect(on).toContain('<a href="/guides/run-an-agent-on-a-schedule">');
    expect(off).not.toContain("ex-related");
  });
});

describe("Explore HTTP routes", () => {
  it("serve the committed activation state", async () => {
    const catalogGet = CatalogJsonRoute.options.server?.handlers;
    const textGet = PromptTextRoute.options.server?.handlers;

    if (
      typeof catalogGet !== "object" ||
      typeof textGet !== "object" ||
      !catalogGet.GET ||
      !textGet.GET
    )
      throw new Error("Missing handlers");

    const json = await (
      catalogGet.GET as (context: { request: Request }) => Response
    )({ request: new Request("https://omnyohq.com/explore/catalog.json") });

    const text = await (
      textGet.GET as (context: { params: { slug: string } }) => Response
    )({ params: { slug: "review-a-product-update" } });

    expect([json.status, text.status]).toEqual(
      exploreActivation === "active" ? [200, 200] : [404, 404],
    );
  });
});
