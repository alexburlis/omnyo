import { createFileRoute } from "@tanstack/react-router";

import { exploreCatalog } from "../explore/entries.server";

export const Route = createFileRoute("/explore/catalog.json")({
  server: {
    handlers: {
      GET: ({ request }) =>
        exploreCatalog.catalogResponse(
          new URL(request.url).searchParams.get("version") === "2" ? 2 : 1,
        ),
    },
  },
});
