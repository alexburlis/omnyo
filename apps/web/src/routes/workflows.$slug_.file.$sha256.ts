import { createFileRoute } from "@tanstack/react-router";

import { workflowCatalog } from "../workflow-catalog/entries.server";

export const Route = createFileRoute("/workflows/$slug_/file/$sha256")({
  server: {
    handlers: {
      GET: ({ params }) =>
        workflowCatalog.attachment(params.slug, params.sha256),
    },
  },
});
