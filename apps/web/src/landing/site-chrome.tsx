import "./site-chrome.css";

import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { guideFooterLinks, guideMenu, type ContentLink } from "./content-links";
import { DownloadButton } from "./download";
import { GITHUB_NAME, GitHubGlyph } from "./github";
import {
  BB_URL,
  GITHUB_URL,
  MACOS_DOWNLOAD_URL,
  TERMS_URL,
  type PublicMacDownload,
} from "./site";
import { ThemeToggle } from "./theme-toggle";

import { explorePath } from "../explore/catalog";
import { ExploreNavigation } from "../explore/navigation";
import { workflowGalleryPath } from "../workflow-catalog/catalog";
import { WorkflowNavigation } from "../workflow-catalog/navigation";

export type SiteSection =
  | "features"
  | "guides"
  | "explore"
  | "workflows"
  | "plugin-guide";

const FEATURES_PATH = "/features";

const PLUGIN_GUIDE_PATH = "/plugin-guide";

const NAV_HIDE_AFTER = 240;

const NAV_SCROLL_SLOP = 6;

export function OmnyoMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="7 7 50 50"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"
        fill="currentColor"
      />
      <circle cx="49.5" cy="14.5" r="6.5" fill="#ff4f17" />
    </svg>
  );
}

function SiteBrand({ href = "/" }: { href?: string }) {
  return (
    <a className="site-brand" href={href} aria-label="Omnyo home">
      <OmnyoMark className="site-brand-mark" />
      <span>Omnyo</span>
    </a>
  );
}

function useDismissableDetails() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !ref.current?.contains(event.target)
      ) {
        ref.current?.removeAttribute("open");
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.removeAttribute("open");
        ref.current.querySelector("summary")?.focus();
      }
    };

    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return {
    ref,
    onBlur: (event: ReactFocusEvent<HTMLDetailsElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        event.currentTarget.removeAttribute("open");
      }
    },
  };
}

function opensOnHover(event: ReactPointerEvent<HTMLElement>) {
  return event.pointerType === "mouse";
}

function GuidesMenu({
  inSection,
  path,
}: {
  inSection: boolean;
  path?: string;
}) {
  const details = useDismissableDetails();

  const [openGroup, setOpenGroup] = useState(
    guideMenu().find(
      (item) =>
        "links" in item && item.links.some((link) => link.href === path),
    )?.label ?? null,
  );

  return (
    <details className="site-nav-menu" {...details}>
      <summary className={inSection ? "is-current" : undefined}>
        Guides
        <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden />
      </summary>
      <div className="site-nav-panel">
        {guideMenu().map((group) => {
          if (!("links" in group)) {
            return (
              <a
                key={group.href}
                href={group.href}
                aria-current={path === group.href ? "page" : undefined}
                onPointerEnter={(event) => {
                  if (opensOnHover(event)) setOpenGroup(null);
                }}
              >
                {group.label}
              </a>
            );
          }

          const open = openGroup === group.label;

          return (
            <div
              key={group.label}
              className={open ? "site-nav-sub open" : "site-nav-sub"}
              onPointerEnter={(event) => {
                if (opensOnHover(event)) setOpenGroup(group.label);
              }}
            >
              <button
                type="button"
                className="site-nav-sub-trigger"
                aria-expanded={open}
                onClick={() => setOpenGroup(open ? null : group.label)}
              >
                {group.label}
                <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden />
              </button>
              <div className="site-nav-sub-panel">
                {group.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    aria-current={path === link.href ? "page" : undefined}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function SectionLink({
  href,
  label,
  inSection,
  path,
}: {
  href: string;
  label: string;
  inSection: boolean;
  path?: string;
}) {
  return (
    <a
      className={inSection ? "is-current" : undefined}
      href={href}
      aria-current={path === href ? "page" : undefined}
    >
      {label}
    </a>
  );
}

interface SectionTarget {
  section: SiteSection;
  href: string;
  label: string;
}

function primaryLinks(
  showWorkflows: boolean,
  showExplore: boolean,
): SectionTarget[] {
  const features: SectionTarget = {
    section: "features",
    href: FEATURES_PATH,
    label: "Features",
  };

  const workflows: SectionTarget = {
    section: "workflows",
    href: workflowGalleryPath,
    label: "Workflows",
  };

  const pluginGuide: SectionTarget = {
    section: "plugin-guide",
    href: PLUGIN_GUIDE_PATH,
    label: "Plugin Guide",
  };

  if (showExplore) {
    return [
      features,
      { section: "explore", href: explorePath, label: "Explore" },
      pluginGuide,
    ];
  }

  return showWorkflows
    ? [features, workflows, pluginGuide]
    : [features, pluginGuide];
}

function inCurrentSection(section: SiteSection, current?: SiteSection) {
  return (
    current === section || (section === "explore" && current === "workflows")
  );
}

function glideTo(nav: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element)) return;

  const item = target.closest(".site-nav-links > a, .site-nav-menu > summary");

  if (!(item instanceof HTMLElement) || !nav.contains(item)) return;

  const navBox = nav.getBoundingClientRect();
  const box = item.getBoundingClientRect();

  nav.style.setProperty("--glide-x", `${box.left - navBox.left}px`);
  nav.style.setProperty("--glide-w", `${box.width}px`);
  nav.dataset.glide = nav.dataset.glide ? "move" : "show";
}

export function SiteNavLinks({
  current,
  path,
}: {
  current?: SiteSection;
  path?: string;
}) {
  const showWorkflows = useContext(WorkflowNavigation);
  const showExplore = useContext(ExploreNavigation);
  const [first, ...rest] = primaryLinks(showWorkflows, showExplore);

  return (
    <nav
      className="site-nav-links"
      aria-label="Site"
      onPointerOver={(event) => {
        if (opensOnHover(event)) glideTo(event.currentTarget, event.target);
      }}
      onPointerLeave={(event) => {
        delete event.currentTarget.dataset.glide;
      }}
    >
      <span className="site-nav-glide" aria-hidden="true" />
      {first ? (
        <SectionLink
          {...first}
          inSection={current === first.section}
          path={path}
        />
      ) : null}
      <GuidesMenu inSection={current === "guides"} path={path} />
      {rest.map((link) => (
        <SectionLink
          key={link.href}
          {...link}
          inSection={inCurrentSection(link.section, current)}
          path={path}
        />
      ))}
      <a className="site-nav-gh" href={GITHUB_URL} aria-label={GITHUB_NAME}>
        <GitHubGlyph className="site-nav-gh-glyph" />
        <span className="site-nav-gh-label">Releases</span>
      </a>
    </nav>
  );
}

export function SiteNavMenu({
  current,
  path,
}: {
  current?: SiteSection;
  path?: string;
}) {
  const showWorkflows = useContext(WorkflowNavigation);
  const showExplore = useContext(ExploreNavigation);
  const details = useDismissableDetails();

  return (
    <details className="site-nav-mobile" {...details}>
      <summary aria-label="Menu">
        <HugeiconsIcon icon={Menu01Icon} aria-hidden />
      </summary>
      <nav className="site-nav-sheet" aria-label="Site">
        <div className="site-nav-sheet-group site-nav-sheet-primary">
          {primaryLinks(showWorkflows, showExplore).map((link) => (
            <a
              key={link.href}
              className={
                inCurrentSection(link.section, current)
                  ? "is-current"
                  : undefined
              }
              href={link.href}
              aria-current={path === link.href ? "page" : undefined}
            >
              {link.label}
            </a>
          ))}
        </div>
        {guideMenu().map((group) =>
          "links" in group ? (
            <div className="site-nav-sheet-group" key={group.label}>
              <p className="site-nav-sheet-head">{group.label}</p>
              {group.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={path === link.href ? "page" : undefined}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ) : (
            <div className="site-nav-sheet-group" key={group.href}>
              <p className="site-nav-sheet-head">Guides</p>
              <a
                href={group.href}
                aria-current={path === group.href ? "page" : undefined}
              >
                {group.label}
              </a>
            </div>
          ),
        )}
        <div className="site-nav-sheet-group site-nav-sheet-end">
          <a className="site-nav-sheet-gh" href={GITHUB_URL}>
            <GitHubGlyph className="site-nav-gh-glyph" />
            <span>Releases on GitHub</span>
          </a>
        </div>
      </nav>
    </details>
  );
}

export function SiteNav({
  current,
  path,
  macDownload,
}: {
  current?: SiteSection;
  path?: string;
  macDownload?: PublicMacDownload | null;
}) {
  const header = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    let last = scrollY;

    const update = () => {
      const node = header.current;

      if (!node) return;

      const y = scrollY;

      if (Math.abs(y - last) > NAV_SCROLL_SLOP || y <= NAV_SCROLL_SLOP) {
        const hide =
          y > NAV_HIDE_AFTER &&
          y > last &&
          node.querySelector("details[open]") === null;

        node.toggleAttribute("data-hidden", hide);
        const visibility = hide ? "hidden" : "shown";

        if (root.dataset.siteNav !== visibility) {
          root.dataset.siteNav = visibility;
        }

        last = y;
      }

      node.toggleAttribute("data-scrolled", y > NAV_SCROLL_SLOP);
    };

    update();
    addEventListener("scroll", update, { passive: true });

    return () => {
      removeEventListener("scroll", update);
      delete root.dataset.siteNav;
    };
  }, []);

  return (
    <header ref={header} className="site-nav">
      <SiteBrand href={path === "/" ? "#top" : "/"} />
      <SiteNavLinks current={current} path={path} />
      <ThemeToggle />
      <DownloadButton macDownload={macDownload} />
      <SiteNavMenu current={current} path={path} />
    </header>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="footer-column">
      <h2 className="footer-title">{title}</h2>
      <ul>{children}</ul>
    </div>
  );
}

function FooterLinks({
  links,
  current,
}: {
  links: ContentLink[];
  current: string | undefined;
}) {
  return links.map((link) => (
    <li key={link.href}>
      <a
        href={link.href}
        aria-current={link.href === current ? "page" : undefined}
      >
        {link.label}
      </a>
    </li>
  ));
}

export function useSiteFooterProductLinks() {
  const showWorkflows = useContext(WorkflowNavigation);
  const showExplore = useContext(ExploreNavigation);

  const product: ContentLink[] = primaryLinks(showWorkflows, showExplore).map(
    ({ href, label }) => ({ href, label }),
  );

  if (showExplore && showWorkflows) {
    product.push({ href: workflowGalleryPath, label: "Workflows" });
  }

  return product;
}

export function SiteFooter({ current }: { current?: string }) {
  const product = useSiteFooterProductLinks();

  return (
    <footer className="site-footer">
      <div className="site-footer-top">
        <div className="site-footer-brand">
          <SiteBrand />
          <p className="site-footer-tag">
            The unified interface for coding agents.
          </p>
        </div>
        <div className="site-footer-cols">
          <FooterColumn title="Product">
            <FooterLinks links={product} current={current} />
            <li>
              <a
                href={MACOS_DOWNLOAD_URL}
                onClick={() =>
                  sendSiteUsage({ name: "download_click", os: "mac" })
                }
              >
                Download for Mac
              </a>
            </li>
            <li>
              <a href={GITHUB_URL}>Releases</a>
            </li>
          </FooterColumn>
          <FooterColumn title="Guides">
            <FooterLinks links={guideFooterLinks()} current={current} />
          </FooterColumn>
          <FooterColumn title="Legal">
            <FooterLinks
              links={[
                { href: "/privacy", label: "Privacy" },
                { href: TERMS_URL, label: "Terms" },
                { href: "/imprint", label: "Imprint" },
                { href: "/cookies", label: "Cookies" },
              ]}
              current={current}
            />
            <li>
              <button
                type="button"
                className="site-footer-button"
                data-cookie-settings
              >
                Cookie settings
              </button>
            </li>
          </FooterColumn>
        </div>
      </div>
      <div className="site-footer-bottom">
        <span>
          Built on <a href={BB_URL}>bb</a> (MIT License)
        </span>
        <span>© {new Date().getFullYear()} Omnyo</span>
      </div>
    </footer>
  );
}

import { sendSiteUsage } from "../analytics/usage";
