import { createFileRoute } from "@tanstack/react-router";
import { workflowSharePage } from "../workflow-share";

export const Route = createFileRoute("/w/$shareId")({
  server: {
    handlers: { GET: ({ params }) => workflowSharePage(params.shareId) },
  },
});
