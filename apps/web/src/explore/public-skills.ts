import { EXPLORE_QUERY_MAX_LENGTH, normalizeExploreQuery } from "./catalog";

export const publicSkillsPath = "/explore/skills";

export const publicSkillPath = (slug: string) =>
  `${publicSkillsPath}/source/${slug}`;

export const publicSkillLicensePath = "/skills/omnyo/LICENSE.txt";

export const publicSkillCategories = [
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

export type PublicSkillCategory = (typeof publicSkillCategories)[number];

export interface PublicSkill {
  slug: string;
  title: string;
  category: PublicSkillCategory;
  publisher: string;
  license: string;
  keywords: string[];
  source: "github" | "omnyo";
  sourceUrl: string;
  revision: string;
  sha256: string;
  detailPath: string;
  summary?: string;
  setupUrl?: string;
  packSlug?: string;
}

export interface PublicSkillsSearch {
  q?: string;
  category?: PublicSkillCategory;
  publisher?: string;
  page?: number;
}

export const PUBLIC_SKILLS_PAGE_SIZE = 24;

export function readPublicSkillCategory(value: unknown) {
  return publicSkillCategories.find((category) => category === value);
}

export function validatePublicSkillsSearch(
  search: Record<string, unknown>,
): PublicSkillsSearch {
  const q =
    typeof search.q === "string" || typeof search.q === "number"
      ? String(search.q)
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, EXPLORE_QUERY_MAX_LENGTH)
          .trim()
      : "";

  const category = readPublicSkillCategory(search.category);

  const publisher =
    typeof search.publisher === "string" &&
    /^[\w.-]+(?:\/[\w.-]+)?$/u.test(search.publisher) &&
    search.publisher.length <= 80
      ? search.publisher
      : undefined;

  const page =
    typeof search.page === "number" ||
    (typeof search.page === "string" && /^\d+$/u.test(search.page))
      ? Number(search.page)
      : 1;

  return {
    ...(q ? { q } : {}),
    ...(category ? { category } : {}),
    ...(publisher ? { publisher } : {}),
    ...(Number.isSafeInteger(page) && page > 1 ? { page } : {}),
  };
}

export function publicSkillsHref(search: PublicSkillsSearch = {}): string {
  const params = new URLSearchParams();

  if (search.q) params.set("q", search.q);

  if (search.category) params.set("category", search.category);

  if (search.publisher) params.set("publisher", search.publisher);

  if (search.page && search.page > 1) params.set("page", String(search.page));

  const query = params.toString();

  return query ? `${publicSkillsPath}?${query}` : publicSkillsPath;
}

export function filterPublicSkills(
  items: readonly PublicSkill[],
  search: PublicSkillsSearch,
): PublicSkill[] {
  const terms = normalizeExploreQuery(search.q ?? "")
    .split(" ")
    .filter(Boolean);

  return items.filter((item) => {
    if (search.category && search.category !== item.category) return false;

    if (search.publisher && search.publisher !== item.publisher) return false;

    const searchable = [
      item.slug,
      item.title,
      item.publisher,
      item.category,
      item.summary,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => searchable.includes(term));
  });
}
