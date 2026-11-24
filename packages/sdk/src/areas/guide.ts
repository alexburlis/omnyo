import { templateDefinitions, type TemplateId } from "@omnyo/templates/generated";

export interface GuideRenderArgs {
  chapter?: string;
}

export interface GuideRenderResult {
  chapter?: string;
  content: string;
}

export interface GuideArea {
  render(args?: GuideRenderArgs): GuideRenderResult;
}

const guideChapters: Record<string, TemplateId> = {
  threads: "omnyoGuideThreads",
  environments: "omnyoGuideEnvironments",
  "agent-configuration": "omnyoGuideAgentConfiguration",
  providers: "omnyoGuideProviders",
  projects: "omnyoGuideProjects",
  machines: "omnyoGuideMachines",
  terminals: "omnyoGuideTerminals",
  browser: "omnyoGuideBrowser",
  customization: "omnyoGuideCustomization",
  plugins: "omnyoGuidePlugins",
  automations: "omnyoGuideAutomations",
  json: "omnyoGuideJson",
};

const guideChapterAliases: Record<string, string> = {
  thread: "threads",
  section: "threads",
  sections: "threads",
  interaction: "threads",
  interactions: "threads",
  queue: "threads",
  permission: "threads",
  permissions: "threads",
  environment: "environments",
  env: "environments",
  worktree: "environments",
  worktrees: "environments",
  agent: "agent-configuration",
  agents: "agent-configuration",
  skill: "agent-configuration",
  skills: "agent-configuration",
  provider: "providers",
  model: "providers",
  models: "providers",
  project: "projects",
  machine: "machines",
  host: "machines",
  hosts: "machines",
  server: "machines",
  terminal: "terminals",
  preview: "terminals",
  previews: "terminals",
  theme: "customization",
  settings: "customization",
  plugin: "plugins",
  marketplace: "plugins",
  automation: "automations",
  "json-output": "json",
  output: "json",
  errors: "json",
};

function resolveGuideChapter(chapter: string): string {
  const normalized = chapter.trim().toLowerCase();

  return guideChapterAliases[normalized] ?? normalized;
}

const templateBodyById = new Map(
  templateDefinitions.map((template) => [template.id, template.body]),
);

function renderStaticTemplate(templateId: TemplateId): string {
  const body = templateBodyById.get(templateId);

  if (body === undefined) {
    throw new Error(`Template '${templateId}' is unavailable.`);
  }

  return body;
}

export function createGuideArea(): GuideArea {
  return {
    render(input = {}) {
      if (!input.chapter) {
        return { content: renderStaticTemplate("omnyoGuideOverview") };
      }

      const chapter = resolveGuideChapter(input.chapter);
      const templateId = guideChapters[chapter];

      if (!templateId) {
        const available = Object.keys(guideChapters).join(", ");
        throw new Error(
          `Unknown guide chapter '${input.chapter}'. Available: ${available}. Commands contributed by plugins document themselves: run \`omnyo <command> --help\`.`,
        );
      }

      return {
        chapter,
        content: renderStaticTemplate(templateId),
      };
    },
  };
}
