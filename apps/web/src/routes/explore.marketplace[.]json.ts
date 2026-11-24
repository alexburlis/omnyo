import { createFileRoute } from "@tanstack/react-router";

import { marketplaceResponse } from "../explore/marketplace.server";

export const Route = createFileRoute("/explore/marketplace.json")({
  server: {
    handlers: {
      GET: ({ request }) =>
        marketplaceResponse(
          new URL(request.url).searchParams.get("provider-setup") === "1",
        ),
    },
  },
});
