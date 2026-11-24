import { createFileRoute } from "@tanstack/react-router";

import { exploreCatalog } from "../explore/entries.server";

export const Route = createFileRoute("/explore/prompts/$slug_/text")({
  server: {
    handlers: {
      GET: ({ params }) => exploreCatalog.promptTextResponse(params.slug),
    },
  },
});
