const linkPattern =
  /^omnyo:\/\/skills\/(import|source)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{64})$/u;

interface SkillPackImportLink {
  kind: "import" | "source";
  slug: string;
  digest: string;
}

export function parseSkillPackImportLink(
  value: string,
): SkillPackImportLink | null {
  if (value.length > 247) return null;
  const match = linkPattern.exec(value);

  if (match?.[0] !== value) return null;
  const [, kind, slug, digest] = match;

  if (
    (kind !== "import" && kind !== "source") ||
    !slug ||
    !digest ||
    slug.length > (kind === "import" ? 64 : 160)
  )
    return null;

  return { kind, slug, digest };
}

export function skillPackImportDestination(
  serverUrl: string,
  entry: SkillPackImportLink,
): string {
  const url = new URL(serverUrl);

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  )
    throw new Error("Expected a connected coordinator.");
  const path = url.pathname.replace(/\/$/u, "");
  url.pathname =
    path +
    `/plugins/skill-discovery/browse/${entry.kind}/` +
    entry.slug +
    "/" +
    entry.digest;
  url.search = "";
  url.hash = "";

  return url.href;
}

export class SkillPackImportQueue {
  private pending: SkillPackImportLink | null = null;

  add(entry: SkillPackImportLink): void {
    this.pending = entry;
  }

  async open(
    serverUrl: string,
    load: (url: string) => Promise<void>,
  ): Promise<void> {
    const entry = this.pending;

    if (entry === null) return;
    this.pending = null;

    try {
      await load(skillPackImportDestination(serverUrl, entry));
    } catch (error) {
      this.pending ??= entry;
      throw error;
    }
  }
}
