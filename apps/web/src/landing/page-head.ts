import bricolageWoff2 from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2?url";
import geistWoff2 from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import type { ComponentProps } from "react";

import landingCss from "./landing.css?url";
import { unfurlMeta } from "./site";

const fontPreload = (href: string): ComponentProps<"link"> => ({
  rel: "preload",
  href,
  as: "font",
  type: "font/woff2",
  crossOrigin: "anonymous",
});

export function siteHeadLinks(
  ...stylesheets: string[]
): Array<ComponentProps<"link">> {
  return [
    fontPreload(geistWoff2),
    fontPreload(bricolageWoff2),
    { rel: "stylesheet", href: landingCss },
    ...stylesheets.map((href) => ({ rel: "stylesheet", href })),
  ];
}

export function pageMeta(title: string, description: string, path: string) {
  return [
    { title },
    { name: "description", content: description },
    ...unfurlMeta(title, description, path),
  ];
}
