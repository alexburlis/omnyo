import { createFileRoute } from "@tanstack/react-router";

import { workflowCatalog } from "../workflow-catalog/entries.server";

export const Route = createFileRoute("/workflows/$slug_/preview.png")({
  server: {
    handlers: {
      GET: ({ params }) => workflowCatalog.previewImage(params.slug),
      HEAD: ({ params }) => workflowCatalog.previewImage(params.slug),
    },
  },
});
