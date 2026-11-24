import { createFileRoute } from "@tanstack/react-router";

import { publicSkillsCatalogResponse } from "../explore/public-skill-catalog.server";

export const Route = createFileRoute("/explore/skills/catalog.json")({
  server: { handlers: { GET: publicSkillsCatalogResponse } },
});
