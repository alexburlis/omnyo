import {
  HeadContent,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";

import consentCss from "../analytics/consent.css?url";
import { SiteConsent } from "../analytics/SiteConsent";
import blogCss from "../blog/blog.css?url";
import { DEVICE_SCRIPT } from "../landing/device";
import landingCss from "../landing/landing.css?url";
import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { canonicalHref } from "../lib/canonical";
import { THEME_COLORS, THEME_INIT, watchTheme } from "../lib/theme";
import { getSiteNavigation } from "../explore/loaders";
import { ExploreNavigation } from "../explore/navigation";
import { WorkflowNavigation } from "../workflow-catalog/navigation";

export const Route = createRootRoute({
  staleTime: Infinity,
  loader: () => getSiteNavigation(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Omnyo" },
    ],
    links: [
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32-dark.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16-dark.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <>
      <link rel="stylesheet" href={landingCss} precedence="default" />
      <link rel="stylesheet" href={blogCss} precedence="default" />
      <SiteNav />
      <div className="wrap">
        <article className="post article">
          <div className="post-body">
            <h1>Page not found</h1>
            <p className="lede">
              This page does not exist or has moved. Start from the{" "}
              <a className="release-link" href="/">
                home page
              </a>{" "}
              or browse the{" "}
              <a className="release-link" href="/features">
                features
              </a>
              .
            </p>
          </div>
        </article>
      </div>
      <SiteFooter />
    </>
  );
}

const JS_INIT = `document.documentElement.classList.add("js")`;

function RootDocument({ children }: { children: React.ReactNode }) {
  useEffect(() => watchTheme(), []);

  const navigation = Route.useLoaderData();

  const canonical = useRouterState({
    select: (state) => canonicalHref(state.matches),
  });

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={THEME_COLORS.light}
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content={THEME_COLORS.dark}
        />
        {}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <script dangerouslySetInnerHTML={{ __html: JS_INIT }} />
        <script dangerouslySetInnerHTML={{ __html: DEVICE_SCRIPT }} />
        {}
        {canonical === null ? null : <link rel="canonical" href={canonical} />}
        <HeadContent />
        <link rel="stylesheet" href={consentCss} />
      </head>
      <body>
        <WorkflowNavigation.Provider value={navigation.workflows}>
          <ExploreNavigation.Provider value={navigation.explore}>
            {children}
          </ExploreNavigation.Provider>
        </WorkflowNavigation.Provider>
        <SiteConsent />
        <Scripts />
      </body>
    </html>
  );
}
