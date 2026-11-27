export interface SkillSource {
  id: string;
  name: string;
  description: string | null;
  filePath: string;
  provider: string | null;
  scope: string;
  pluginId: string | null;
}

export interface SkillEntry {
  key: string;
  name: string;
  label: string;
  summary: string;
  description: string;
  category: string[];
  sources: SkillSource[];
  providers: string[];
  scopes: string[];
}

interface Placement {
  label: string;
  category: string[];
}

const familySize = 3;

const groupSize = 2;

const acronyms = new Set([
  "ai",
  "api",
  "aws",
  "ci",
  "cli",
  "css",
  "gcp",
  "gpu",
  "html",
  "ios",
  "mcp",
  "pdf",
  "qa",
  "seo",
  "sql",
  "ui",
  "ux",
  "vfx",
]);

const topics: [string[], Set<string>][] = [
  [
    ["Development", "Security"],
    new Set(["security", "secure", "vulnerability", "secrets", "threat"]),
  ],
  [
    ["Development", "Testing and review"],
    new Set([
      "test",
      "tests",
      "testing",
      "review",
      "debug",
      "fix",
      "refactor",
      "lint",
      "qa",
      "tdd",
      "commit",
      "release",
    ]),
  ],
  [
    ["Development", "Apple platforms"],
    new Set(["ios", "macos", "swift", "swiftui", "xcode", "apple"]),
  ],
  [
    ["Development", "Web"],
    new Set(["react", "nextjs", "vue", "svelte", "web", "frontend", "css", "tailwind", "html"]),
  ],
  [
    ["Data", "Analysis"],
    new Set([
      "data",
      "analytics",
      "sql",
      "database",
      "chart",
      "charts",
      "dataviz",
      "visualization",
      "spreadsheet",
      "xlsx",
      "csv",
    ]),
  ],
  [
    ["Infrastructure", "Deployment"],
    new Set([
      "deploy",
      "deployment",
      "docker",
      "kubernetes",
      "terraform",
      "aws",
      "gcp",
      "azure",
      "infra",
      "infrastructure",
    ]),
  ],
  [["Marketing", "Search"], new Set(["seo", "keyword", "keywords", "serp"])],
  [
    ["Marketing", "Growth and copy"],
    new Set(["marketing", "copy", "copywriting", "launch", "growth", "ads", "social", "brand"]),
  ],
  [["Communication", "Email"], new Set(["email", "mail", "newsletter"])],
  [
    ["Creative", "Design and media"],
    new Set([
      "design",
      "ui",
      "ux",
      "image",
      "images",
      "video",
      "motion",
      "animation",
      "audio",
      "music",
      "art",
    ]),
  ],
  [
    ["Productivity", "Documents"],
    new Set(["doc", "docs", "docx", "pdf", "pptx", "slides", "notes", "document", "documents"]),
  ],
];

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function title(parts: string[]): string {
  return parts
    .map((part) =>
      acronyms.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

export function skillDisplayName(name: string): string {
  return title(splitName(name).local);
}

function splitName(name: string): { namespace: string | null; local: string[] } {
  const index = name.lastIndexOf(":");

  return index === -1
    ? { namespace: null, local: words(name) }
    : { namespace: name.slice(0, index), local: words(name.slice(index + 1)) };
}

function sharedPrefix(lists: string[][], minimum: number): (tokens: string[]) => string[] {
  const counts = new Map<string, number>();

  for (const key of new Set(lists.map((list) => list.join(" ")))) {
    const tokens = key.split(" ").filter(Boolean);

    for (let length = 1; length <= tokens.length; length += 1) {
      const prefix = tokens.slice(0, length).join(" ");
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  return (tokens) => {
    const count = (length: number) => counts.get(tokens.slice(0, length).join(" ")) ?? 0;
    let length = 1;

    while (length <= tokens.length && count(length) < minimum) length += 1;

    if (length > tokens.length) return [];

    while (length < tokens.length && count(length + 1) === count(length)) length += 1;

    return tokens.slice(0, length);
  };
}

function topicFor(tokens: string[]): string[] {
  for (const [category, vocabulary] of topics)
    if (tokens.some((token) => vocabulary.has(token))) return category;

  return ["Other", "General"];
}

function placements(sources: SkillSource[]): (source: SkillSource) => Placement {
  const names = [...new Set(sources.map((source) => source.name))].map((name) => ({
    name,
    ...splitName(name),
  }));

  const namespaceSizes = new Map<string, number>();

  for (const { namespace } of names)
    if (namespace !== null) namespaceSizes.set(namespace, (namespaceSizes.get(namespace) ?? 0) + 1);

  const isNamespaceFamily = (namespace: string | null): namespace is string =>
    namespace !== null && (namespaceSizes.get(namespace) ?? 0) >= familySize;

  const familyOf = sharedPrefix(
    names.flatMap((entry) => (isNamespaceFamily(entry.namespace) ? [] : [entry.local])),
    familySize,
  );

  const members = new Map<string, string[][]>();

  const rootOf = (entry: (typeof names)[number]): { key: string; prefix: string[] } | null => {
    if (isNamespaceFamily(entry.namespace))
      return { key: `namespace:${entry.namespace}`, prefix: [] };

    const prefix = familyOf(entry.local);

    return prefix.length === 0 ? null : { key: `prefix:${prefix.join(" ")}`, prefix };
  };

  for (const entry of names) {
    const root = rootOf(entry);

    if (root === null) continue;
    const list = members.get(root.key) ?? [];
    list.push(entry.local.slice(root.prefix.length));
    members.set(root.key, list);
  }

  const groupings = new Map(
    [...members].map(([key, lists]) => [key, sharedPrefix(lists, groupSize)] as const),
  );

  const byName = new Map<string, Placement>();

  for (const entry of names) {
    const root = rootOf(entry);

    if (root === null) {
      byName.set(entry.name, {
        label: title(entry.local),
        category: topicFor(words(entry.name)),
      });
      continue;
    }

    const remainder = entry.local.slice(root.prefix.length);
    const group = groupings.get(root.key)?.(remainder) ?? [];

    byName.set(entry.name, {
      label: title(root.prefix.length > 0 && remainder.length > 0 ? remainder : entry.local),
      category: [
        entry.namespace !== null && root.prefix.length === 0
          ? title(words(entry.namespace))
          : title(root.prefix),
        group.length > 0 ? title(group) : "General",
      ],
    });
  }

  return (source) => {
    const placement = byName.get(source.name) ?? {
      label: skillDisplayName(source.name),
      category: ["Other", "General"],
    };

    if (source.pluginId !== null || source.scope === "omnyo-builtin")
      return {
        label: skillDisplayName(source.name),
        category: [
          "Omnyo plugins",
          source.pluginId === null ? "Built-in" : title(words(source.pluginId)),
        ],
      };

    return placement;
  };
}

function brief(description: string, root: string | undefined): string {
  const unlabelled =
    root !== undefined && description.toLowerCase().startsWith(`${root.toLowerCase()}:`)
      ? description.slice(root.length + 1).trimStart()
      : description;

  const first = unlabelled.split(/\.\s/)[0] ?? "";

  if (first.length <= 160) return first;
  const cut = first.slice(0, 157);

  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

function scopeFamily(scope: string): string {
  if (scope.endsWith("-project")) return "project";

  if (scope.endsWith("-user")) return "user";

  return scope;
}

function labels(sources: SkillSource[]) {
  const providers = new Set<string>();
  const scopes = new Set<string>();

  for (const source of sources) {
    providers.add(source.provider ?? "shared");
    scopes.add(source.scope);
  }

  return { providers: [...providers].sort(), scopes: [...scopes].sort() };
}

export function buildCatalogue(sources: SkillSource[]): SkillEntry[] {
  const entries = new Map<string, SkillEntry>();
  const place = placements(sources);

  for (const source of sources) {
    const description = source.description ?? "";

    // Group equal discovery descriptors within the same origin tier.
    // Preserve every variant: equal descriptors do not prove equal instructions.
    const key = JSON.stringify([
      source.name,
      description,
      scopeFamily(source.scope),
      source.pluginId,
    ]);

    const current = entries.get(key);

    if (current !== undefined) {
      current.sources.push(source);
      continue;
    }

    const placement = place(source);

    entries.set(key, {
      key,
      name: source.name,
      label: placement.label,
      summary: brief(description, placement.category[0]),
      description,
      category: placement.category,
      sources: [source],
      providers: [],
      scopes: [],
    });
  }

  const result = [...entries.values()];

  for (const entry of result) {
    entry.sources.sort(
      (a, b) =>
        (a.provider ?? "").localeCompare(b.provider ?? "") || a.filePath.localeCompare(b.filePath),
    );
    Object.assign(entry, labels(entry.sources));
  }

  return result.sort(
    (a, b) =>
      a.category.join(" > ").localeCompare(b.category.join(" > ")) ||
      a.label.localeCompare(b.label),
  );
}

export function filterCatalogue(
  entries: SkillEntry[],
  query: string,
  provider: string,
  scope: string,
): SkillEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches: SkillEntry[] = [];

  for (const entry of entries) {
    const sources = entry.sources.filter(
      (source) =>
        (provider === "" || (source.provider ?? "shared") === provider) &&
        (scope === "" || source.scope === scope),
    );

    if (sources.length === 0) continue;

    const haystack = [entry.name, entry.label, entry.description, entry.summary, ...entry.category]
      .join(" ")
      .toLowerCase();

    if (!words.every((word) => haystack.includes(word))) continue;

    matches.push({ ...entry, sources, ...labels(sources) });
  }

  return matches;
}
