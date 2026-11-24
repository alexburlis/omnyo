import { createFileRoute } from "@tanstack/react-router";

import { exploreCatalog } from "../explore/entries.server";

export const Route = createFileRoute("/explore/skills/$slug_/file/$sha256")({
  server: {
    handlers: {
      GET: ({ params }) =>
        exploreCatalog.skillFileResponse(params.slug, params.sha256),
    },
  },
});
