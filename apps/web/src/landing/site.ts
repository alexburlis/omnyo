import {
  ALIAS_ASSET_NAME,
  PUBLIC_MAC_RELEASE_URL,
  RELEASES_REPOSITORY,
} from "@omnyo/config/public-mac-release";

declare const __SITE_ORIGIN__: string;

export const SITE_URL = __SITE_ORIGIN__;

export const MACOS_DOWNLOAD_URL = PUBLIC_MAC_RELEASE_URL + ALIAS_ASSET_NAME;

export interface PublicMacDownload {
  version: string;
  url: string;
}

export const BB_URL = "https://github.com/get-bb/bb";

export const REPO_URL = `https://github.com/${RELEASES_REPOSITORY}`;

export const GITHUB_URL = `${REPO_URL}/releases`;

export const TERMS_URL = "/terms";

export const OPERATOR = {
  name: "Burlis Management GmbH",
  addressLines: ["Philippstraße 27", "52349 Düren", "Germany"],
  representative: "Alexander Burlis",
  registerCourt: "Amtsgericht Düren",
  commercialRegister: "HRB 7595",
  vatId: "DE316238171",
  phone: "+49 177 6436530",
  email: "hello@omnyohq.com",
} as const;

export const ABUSE_EMAIL = "abuse@omnyo.link";

export const OG_DESCRIPTION =
  "Bring your coding agents together in one private workspace.";

export function unfurlMeta(
  title: string,
  description: string,
  path: string,
  image = {
    path: "/og.png",
    width: 2400,
    height: 1260,
    alt: "The Omnyo logo beside the words: The unified interface for coding agents. Free, open source, and local-first.",
  },
) {
  return [
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: `${SITE_URL}${path}` },
    { property: "og:site_name", content: "Omnyo" },
    { property: "og:image", content: `${SITE_URL}${image.path}` },
    { property: "og:image:width", content: String(image.width) },
    { property: "og:image:height", content: String(image.height) },
    {
      property: "og:image:alt",
      content: image.alt,
    },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: `${SITE_URL}${image.path}` },
  ];
}
