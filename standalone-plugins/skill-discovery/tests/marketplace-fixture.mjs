export const skill = {
  kind: "skill",
  slug: "documentation-writer",
  title: "Documentation Writer",
  summary: "Review clear technical documents.",
  publisher: "GitHub Awesome Copilot",
  category: "Writing & documents",
  keywords: ["writing", "review"],
  detailPath: "/explore/skills/source/documentation-writer",
  source: "github",
  sourceUrl:
    "https://github.com/github/awesome-copilot/blob/f10fdb8b2660ce85c98f220b2f1ca24653768a5c/skills/documentation-writer/SKILL.md",
  revision: "f10fdb8b2660ce85c98f220b2f1ca24653768a5c",
  sha256: "7e8244988c9f4eb63bf8c0edf160578544621eb96e5e51e2d848f1401c5de8f1",
  license: "MIT",
};

export const workflow = {
  kind: "workflow",
  slug: "weekly-review",
  title: "Weekly Review",
  summary: "Prepare a review each week.",
  publisher: "Omnyo",
  category: "Agent workflows",
  keywords: ["review"],
  detailPath: "/workflows/weekly-review",
  sha256: "1234567890abcdef".repeat(4),
  requirements: "A connected machine and model provider.",
};

export const connector = {
  kind: "connector",
  slug: "workspace-github",
  pluginId: "workspace-github",
  title: "Workspace GitHub",
  summary: "Browse repository issues and pull requests.",
  publisher: "Omnyo",
  category: "Coding & architecture",
  keywords: ["repository"],
  detailPath: "/explore/plugins/workspace-github",
  service: "GitHub",
  requirements: "A GitHub account.",
  availability: "Available in Omnyo.",
};

export const catalog = { schemaVersion: 1, items: [workflow, connector, skill] };

export const response = {
  catalog,
  reviewedSkills: { "documentation-writer": "github/awesome-copilot/documentation-writer" },
};
