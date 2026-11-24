import { z } from "zod";

export const siteUsageRoutes = [
  "home",
  "features",
  "feature",
  "guides",
  "guide",
  "compare",
  "marketplace",
  "listing",
  "workflows",
  "workflow",
  "privacy",
  "cookies",
  "terms",
  "imprint",
  "abuse",
  "plugin_guide",
  "other",
] as const;

export const siteUsageOperatingSystems = [
  "mac",
  "windows",
  "ios",
  "android",
] as const;

export const siteUsageResultBuckets = [
  "0",
  "1-5",
  "6-20",
  "21-100",
  "101+",
] as const;

export const siteUsageListingKinds = [
  "skill",
  "workflow",
  "connector",
] as const;

export const siteUsageEventSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("route_view"),
    route: z.enum(siteUsageRoutes),
  }),
  z.strictObject({
    name: z.literal("download_click"),
    os: z.enum(siteUsageOperatingSystems),
  }),
  z.strictObject({
    name: z.literal("marketplace_results"),
    count: z.enum(siteUsageResultBuckets),
  }),
  z.strictObject({
    name: z.literal("listing_open"),
    kind: z.enum(siteUsageListingKinds),
  }),
  z.strictObject({
    name: z.literal("install_intent"),
    kind: z.enum(siteUsageListingKinds),
  }),
]);

export const siteUsageRequestSchema = z.strictObject({
  event: siteUsageEventSchema,
});

export type SiteUsageEvent = z.infer<typeof siteUsageEventSchema>;

export type SiteUsageRequest = z.infer<typeof siteUsageRequestSchema>;

export const SITE_USAGE_DICTIONARY = [
  {
    name: "route_view",
    purpose: "Compare use of sections of the website.",
    fields: `route: ${siteUsageRoutes.join(", ")}`,
  },
  {
    name: "download_click",
    purpose:
      "Count clicks on an available app download; a click is not an installation.",
    fields: `os: ${siteUsageOperatingSystems.join(", ")}`,
  },
  {
    name: "marketplace_results",
    purpose:
      "See whether Marketplace searches and filters return useful numbers of results.",
    fields: `count: ${siteUsageResultBuckets.join(", ")}`,
  },
  {
    name: "listing_open",
    purpose: "Compare interest in the kinds of public Marketplace listings.",
    fields: `kind: ${siteUsageListingKinds.join(", ")}`,
  },
  {
    name: "install_intent",
    purpose:
      "Count clicks that open an install or its instructions; a click is not an installation.",
    fields: `kind: ${siteUsageListingKinds.join(", ")}`,
  },
] as const;
