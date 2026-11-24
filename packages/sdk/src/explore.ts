import { z } from "zod";

export const OMNYO_EXPLORE_ORIGIN = "https://omnyohq.com";

export const EXPLORE_SCHEMA_VERSION = 2;

export const EXPLORE_KINDS = [
  "prompt",
  "workflow",
  "skill",
  "plugin",
  "guide",
] as const;

export const EXPLORE_QUERY_MAX_LENGTH = 80;

const CATALOG_MAX_ITEMS = 500;

const CATALOG_MAX_BYTES = 1024 * 1024;

const PROMPT_TEXT_MAX_BYTES = 64 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;

const SLUG_MAX_LENGTH = 64;

const PATH_MAX_LENGTH = 200;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const PATH_FORBIDDEN_PATTERN = /[\s\\]/u;

export type ExploreKind = (typeof EXPLORE_KINDS)[number];

export interface ExplorePreview {
  path: string;
  alt: string;
  width: number;
  height: number;
}

export type ExploreCta =
  | { kind: "copy-prompt"; label: string; textPath: string }
  | { kind: "get-workflow"; label: string; path: string }
  | { kind: "get-skill-pack"; label: string; path: string }
  | {
      kind: "find-in-omnyo";
      label: string;
      pluginId: string;
      marketplace: string;
      install: string;
    }
  | { kind: "read-guide"; label: string; path: string };

export interface ExploreItem {
  kind: ExploreKind;
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  tags: string[];
  path: string;
  preview: ExplorePreview | null;
  cta: ExploreCta;
}

export interface ExploreCatalog {
  schemaVersion: 1 | typeof EXPLORE_SCHEMA_VERSION;
  items: ExploreItem[];
}

const exploreSkillSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    title: z.string().min(1).max(180),
    category: z.string().min(1).max(80),
    publisher: z.string().min(1).max(120),
    license: z.string().min(1).max(80),
    keywords: z.array(z.string().min(1).max(80)).max(32),
    sourceUrl: z.string().min(1).max(2048),
    source: z.enum(["github", "omnyo"]),
    revision: z.string().min(1).max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    summary: z.string().min(1).max(1000).optional(),
    detailPath: z.string().min(1).max(200),
  })
  .superRefine((item, context) => {
    if (item.detailPath !== `/explore/skills/source/${item.slug}`) {
      context.addIssue({
        code: "custom",
        path: ["detailPath"],
        message: "must match the skill slug",
      });
    }

    let url: URL;

    try {
      url = new URL(item.sourceUrl);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "expected an absolute source URL",
      });

      return;
    }

    const validSource =
      url.href === item.sourceUrl &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      (item.source === "github"
        ? url.hostname === "github.com" &&
          /^[a-f0-9]{40}$/u.test(item.revision) &&
          /^[\w.-]+\/[\w.-]+$/u.test(item.publisher) &&
          url.pathname.startsWith(
            `/${item.publisher}/blob/${item.revision}/`,
          ) &&
          url.pathname.endsWith("/SKILL.md")
        : item.publisher === "Omnyo" &&
          /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(item.revision) &&
          item.sourceUrl ===
            `https://omnyohq.com/skills/omnyo/${item.slug}/${item.revision}/SKILL.md`);

    if (!validSource) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "expected a pinned GitHub source or versioned Omnyo skill URL",
      });
    }
  });

const exploreSkillsSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(exploreSkillSchema).max(1024),
  })
  .superRefine((catalog, context) => {
    const seen = new Set<string>();

    for (const [index, item] of catalog.items.entries()) {
      if (seen.has(item.slug))
        context.addIssue({
          code: "custom",
          path: ["items", index, "slug"],
          message: "duplicate skill slug",
        });
      seen.add(item.slug);
    }
  });

export type ExploreSkill = z.infer<typeof exploreSkillSchema>;

export type ExploreSkillsCatalog = z.infer<typeof exploreSkillsSchema>;

export const EXPLORE_MARKETPLACE_KINDS = [
  "skill",
  "workflow",
  "connector",
] as const;

export const EXPLORE_MARKETPLACE_CATEGORIES = [
  "Coding & architecture",
  "Design & UI",
  "Cloud & DevOps",
  "Testing & security",
  "Research & data",
  "Writing & documents",
  "Product & teamwork",
  "Marketing & growth",
  "Agent workflows",
] as const;

const marketplaceFields = {
  slug: exploreSkillSchema.shape.slug,
  title: exploreSkillSchema.shape.title,
  summary: exploreSkillSchema.shape.summary,
  publisher: exploreSkillSchema.shape.publisher,
  category: z.enum(EXPLORE_MARKETPLACE_CATEGORIES),
  keywords: exploreSkillSchema.shape.keywords,
  detailPath: exploreSkillSchema.shape.detailPath,
};

const marketplaceItemSchema = z
  .discriminatedUnion("kind", [
    exploreSkillSchema.safeExtend({
      kind: z.literal("skill"),
      category: marketplaceFields.category,
    }),
    z.object({
      ...marketplaceFields,
      kind: z.literal("workflow"),
      sha256: exploreSkillSchema.shape.sha256,
      requirements: z.string().min(1).max(2000),
    }),
    z.object({
      ...marketplaceFields,
      kind: z.literal("connector"),
      pluginId: z.string().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN),
      service: z.string().min(1).max(120),
      requirements: z.string().min(1).max(2000),
      availability: z.string().min(1).max(2000),
    }),
  ])
  .superRefine((item, context) => {
    if (
      item.kind === "workflow" &&
      item.detailPath !== `/workflows/${item.slug}`
    )
      context.addIssue({
        code: "custom",
        path: ["detailPath"],
        message: "must match the workflow slug",
      });

    if (item.kind === "connector") {
      if (item.slug !== item.pluginId)
        context.addIssue({
          code: "custom",
          path: ["slug"],
          message: "must match the plugin ID",
        });

      if (item.detailPath !== `/explore/plugins/${item.pluginId}`)
        context.addIssue({
          code: "custom",
          path: ["detailPath"],
          message: "must match the plugin ID",
        });
    }
  });

const marketplaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(marketplaceItemSchema).max(1024),
  })
  .superRefine((catalog, context) => {
    const paths = new Set<string>();

    for (const [index, item] of catalog.items.entries()) {
      if (paths.has(item.detailPath))
        context.addIssue({
          code: "custom",
          path: ["items", index, "detailPath"],
          message: "duplicate detail path",
        });
      paths.add(item.detailPath);
    }
  });

export type ExploreMarketplaceKind = (typeof EXPLORE_MARKETPLACE_KINDS)[number];

export type ExploreMarketplaceCategory =
  (typeof EXPLORE_MARKETPLACE_CATEGORIES)[number];

export type ExploreMarketplaceItem = z.infer<typeof marketplaceItemSchema>;

export type ExploreMarketplaceCatalog = z.infer<typeof marketplaceSchema>;

export function parseExploreMarketplace(
  value: unknown,
): ExploreMarketplaceCatalog {
  const result = marketplaceSchema.safeParse(value);

  if (!result.success)
    throw new ExploreFormatError(
      `Invalid Explore marketplace: ${result.error.message}`,
    );

  return result.data;
}

export function filterExploreMarketplace(
  items: readonly ExploreMarketplaceItem[],
  filter: {
    kind?: ExploreMarketplaceKind;
    query?: string;
    category?: ExploreMarketplaceCategory;
    publisher?: string;
  },
): ExploreMarketplaceItem[] {
  const terms = normalizeExploreQuery(filter.query ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    if (filter.kind !== undefined && item.kind !== filter.kind) return false;

    if (filter.category !== undefined && item.category !== filter.category)
      return false;

    if (filter.publisher !== undefined && item.publisher !== filter.publisher)
      return false;

    const haystack = [
      item.slug,
      item.title,
      item.summary,
      item.publisher,
      item.category,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function parseExploreSkills(value: unknown): ExploreSkillsCatalog {
  const result = exploreSkillsSchema.safeParse(value);

  if (!result.success)
    throw new ExploreFormatError(
      `Invalid Explore skills catalog: ${result.error.message}`,
    );

  return result.data;
}

export function filterExploreSkills(
  items: readonly ExploreSkill[],
  filter: { query?: string },
): ExploreSkill[] {
  const terms = normalizeExploreQuery(filter.query ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    const haystack = [
      item.slug,
      item.title,
      item.publisher,
      item.category,
      item.summary,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export interface ExploreReadOptions {
  fetch?: typeof fetch;
  origin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ExploreUnavailableError extends Error {
  readonly status: number | null;
  readonly url: string;

  constructor(
    message: string,
    details: { status: number | null; url: string; cause?: unknown },
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ExploreUnavailableError";
    this.status = details.status;
    this.url = details.url;
  }
}

export class ExploreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExploreFormatError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(location: string, reason: string): never {
  throw new ExploreFormatError(
    `Invalid Explore catalog at ${location}: ${reason}`,
  );
}

function readObject(value: unknown, location: string): JsonObject {
  if (!isObject(value)) return invalid(location, "expected an object");

  return value;
}

function readString(
  source: JsonObject,
  key: string,
  location: string,
  min: number,
  max: number,
): string {
  const value = source[key];
  const where = `${location}.${key}`;

  if (typeof value !== "string") return invalid(where, "expected a string");

  if (value.length < min || value.length > max) {
    return invalid(where, `expected ${min} to ${max} characters`);
  }

  return value;
}

function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

function readSlug(source: JsonObject, key: string, location: string): string {
  const value = readString(source, key, location, 1, SLUG_MAX_LENGTH);

  if (!isSlug(value))
    return invalid(`${location}.${key}`, "expected a lowercase slug");

  return value;
}

function readPath(source: JsonObject, key: string, location: string): string {
  const value = readString(source, key, location, 1, PATH_MAX_LENGTH);

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    PATH_FORBIDDEN_PATTERN.test(value)
  ) {
    return invalid(`${location}.${key}`, "expected a site-relative path");
  }

  return value;
}

function readKind(source: JsonObject, location: string): ExploreKind {
  const value = source.kind;
  const kind = EXPLORE_KINDS.find((candidate) => candidate === value);

  if (kind === undefined) return invalid(`${location}.kind`, "unknown kind");

  return kind;
}

function readDimension(
  source: JsonObject,
  key: string,
  location: string,
): number {
  const value = source[key];

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return invalid(`${location}.${key}`, "expected a positive integer");
  }

  return value;
}

function readPreview(value: unknown, location: string): ExplorePreview | null {
  if (value === null) return null;
  const source = readObject(value, location);

  return {
    path: readPath(source, "path", location),
    alt: readString(source, "alt", location, 1, 300),
    width: readDimension(source, "width", location),
    height: readDimension(source, "height", location),
  };
}

function readTags(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) return invalid(location, "expected an array");

  if (value.length > 12) return invalid(location, "expected at most 12 tags");

  return value.map((tag: unknown, index) => {
    if (typeof tag !== "string" || tag.length < 1 || tag.length > 32) {
      return invalid(`${location}[${index}]`, "expected 1 to 32 characters");
    }

    return tag;
  });
}

function readCta(
  value: unknown,
  kind: ExploreKind,
  location: string,
): ExploreCta {
  const source = readObject(value, location);
  const label = readString(source, "label", location, 1, 40);

  switch (kind) {
    case "prompt":
      if (source.kind !== "copy-prompt") break;

      return {
        kind: "copy-prompt",
        label,
        textPath: readPath(source, "textPath", location),
      };
    case "workflow":
      if (source.kind !== "get-workflow") break;

      return {
        kind: "get-workflow",
        label,
        path: readPath(source, "path", location),
      };
    case "skill":
      if (source.kind !== "get-skill-pack") break;

      return {
        kind: "get-skill-pack",
        label,
        path: readPath(source, "path", location),
      };
    case "plugin":
      if (source.kind !== "find-in-omnyo") break;

      return {
        kind: "find-in-omnyo",
        label,
        pluginId: readSlug(source, "pluginId", location),
        marketplace: readSlug(source, "marketplace", location),
        install: readString(source, "install", location, 1, 200),
      };
    case "guide":
      if (source.kind !== "read-guide") break;

      return {
        kind: "read-guide",
        label,
        path: readPath(source, "path", location),
      };
  }

  return invalid(`${location}.kind`, `does not match item kind ${kind}`);
}

function readItem(value: unknown, location: string): ExploreItem {
  const source = readObject(value, location);
  const kind = readKind(source, location);

  return {
    kind,
    slug: readSlug(source, "slug", location),
    title: readString(source, "title", location, 1, 120),
    summary: readString(source, "summary", location, 1, 400),
    publisher: readString(source, "publisher", location, 1, 80),
    tags: readTags(source.tags, `${location}.tags`),
    path: readPath(source, "path", location),
    preview: readPreview(source.preview, `${location}.preview`),
    cta: readCta(source.cta, kind, `${location}.cta`),
  };
}

export function parseExploreCatalog(value: unknown): ExploreCatalog {
  const source = readObject(value, "catalog");
  const { schemaVersion } = source;

  if (schemaVersion !== 1 && schemaVersion !== EXPLORE_SCHEMA_VERSION) {
    return invalid(
      "catalog.schemaVersion",
      `expected 1 or ${EXPLORE_SCHEMA_VERSION}`,
    );
  }

  const rawItems = source.items;

  if (!Array.isArray(rawItems))
    return invalid("catalog.items", "expected an array");

  if (rawItems.length > CATALOG_MAX_ITEMS) {
    return invalid(
      "catalog.items",
      `expected at most ${CATALOG_MAX_ITEMS} items`,
    );
  }

  const seen = new Set<string>();

  const items = rawItems.map((raw: unknown, index) => {
    const item = readItem(raw, `catalog.items[${index}]`);
    const key = `${item.kind}/${item.slug}`;

    if (schemaVersion === 1 && item.kind === "skill")
      return invalid(
        `catalog.items[${index}].kind`,
        "skill packs require version 2",
      );

    if (seen.has(key))
      return invalid(`catalog.items[${index}]`, `duplicate item ${key}`);
    seen.add(key);

    return item;
  });

  return { schemaVersion, items };
}

export function normalizeExploreQuery(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, EXPLORE_QUERY_MAX_LENGTH)
    .trim()
    .toLowerCase();
}

export function filterExploreItems(
  items: readonly ExploreItem[],
  filter: { kind?: ExploreKind; query?: string },
): ExploreItem[] {
  const terms = normalizeExploreQuery(filter.query ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    if (filter.kind !== undefined && item.kind !== filter.kind) return false;

    const haystack = [item.title, item.summary, ...item.tags]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function parseExploreKey(
  input: string,
): { kind: ExploreKind; slug: string } | null {
  const parts = input.split("/");

  if (parts.length !== 2) return null;
  const kind = EXPLORE_KINDS.find((candidate) => candidate === parts[0]);

  if (kind === undefined || !isSlug(parts[1])) return null;

  return { kind, slug: parts[1] };
}

export function exploreUrl(
  path: string,
  origin: string = OMNYO_EXPLORE_ORIGIN,
): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new ExploreFormatError(
      `Explore path must start with a single "/": ${path}`,
    );
  }

  return new URL(path, origin).href;
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const tooLarge = (): ExploreUnavailableError =>
    new ExploreUnavailableError(
      `Explore response from ${url} is larger than ${maxBytes} bytes`,
      {
        status: response.status,
        url,
      },
    );

  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }

  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function decodeUtf8(bytes: Uint8Array, url: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new ExploreFormatError(
      `Explore response from ${url} is not valid UTF-8: ${String(error)}`,
    );
  }
}

async function readExploreBody(
  path: string,
  accept: "application/json" | "text/plain",
  maxBytes: number,
  options: ExploreReadOptions,
): Promise<string> {
  const url = exploreUrl(path, options.origin);
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );

  const forwardAbort = (): void => controller.abort(options.signal?.reason);

  if (options.signal?.aborted === true) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExploreUnavailableError(
        `Explore request to ${url} failed with HTTP ${response.status}`,
        {
          status: response.status,
          url,
        },
      );
    }

    if (mediaType(response) !== accept) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExploreUnavailableError(
        `Explore response from ${url} has content type ${response.headers.get("content-type") ?? "none"}, expected ${accept}`,
        { status: response.status, url },
      );
    }

    return decodeUtf8(await readBoundedBody(response, maxBytes, url), url);
  } catch (error) {
    if (
      error instanceof ExploreUnavailableError ||
      error instanceof ExploreFormatError
    ) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);

    throw new ExploreUnavailableError(
      `Explore request to ${url} failed: ${reason}`,
      {
        status: null,
        url,
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function readExploreCatalog(
  options: ExploreReadOptions = {},
): Promise<ExploreCatalog> {
  const text = await readExploreBody(
    `/explore/catalog.json?version=${EXPLORE_SCHEMA_VERSION}`,
    "application/json",
    CATALOG_MAX_BYTES,
    options,
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExploreFormatError("Explore catalog is not valid JSON");
  }

  return parseExploreCatalog(parsed);
}

export async function readExploreSkills(
  options: ExploreReadOptions = {},
): Promise<ExploreSkillsCatalog> {
  const text = await readExploreBody(
    "/explore/skills/catalog.json",
    "application/json",
    CATALOG_MAX_BYTES,
    options,
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExploreFormatError("Explore skills catalog is not valid JSON");
  }

  return parseExploreSkills(parsed);
}

export async function readExploreMarketplace(
  options: ExploreReadOptions = {},
): Promise<ExploreMarketplaceCatalog> {
  const text = await readExploreBody(
    "/explore/marketplace.json",
    "application/json",
    CATALOG_MAX_BYTES,
    options,
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExploreFormatError("Explore marketplace is not valid JSON");
  }

  return parseExploreMarketplace(parsed);
}

export async function readExplorePromptText(
  slug: string,
  options: ExploreReadOptions = {},
): Promise<string> {
  if (!isSlug(slug)) {
    throw new ExploreFormatError(`Invalid Explore prompt slug: ${slug}`);
  }

  return readExploreBody(
    `/explore/prompts/${slug}/text`,
    "text/plain",
    PROMPT_TEXT_MAX_BYTES,
    options,
  );
}
