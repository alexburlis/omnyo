import { createFileRoute } from "@tanstack/react-router";

function health(): Response {
  return Response.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}

export const Route = createFileRoute("/api/v0/health")({
  server: { handlers: { GET: health, HEAD: health } },
});
