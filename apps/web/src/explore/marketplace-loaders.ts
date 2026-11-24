import { createServerFn } from "@tanstack/react-start";

import { marketplaceKinds, type MarketplaceKind } from "./marketplace";
import { marketplaceDetail } from "./marketplace-detail.server";
import { marketplaceItems } from "./marketplace.server";

export const loadMarketplace = createServerFn({ method: "GET" }).handler(
  () => marketplaceItems,
);

export const loadMarketplaceDetail = createServerFn({ method: "GET" })
  .validator((input: { kind: MarketplaceKind; slug: string }) => ({
    kind: marketplaceKinds.find((kind) => kind === input.kind) ?? "skill",
    slug: typeof input.slug === "string" ? input.slug : "",
  }))
  .handler(({ data }) => marketplaceDetail(data.kind, data.slug));
