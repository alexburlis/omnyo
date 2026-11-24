import snapshot from "./public-skill-catalog.json";
import {
  filterPublicSkills,
  PUBLIC_SKILLS_PAGE_SIZE,
  publicSkillPath,
  readPublicSkillCategory,
  type PublicSkill,
  type PublicSkillsSearch,
} from "./public-skills";
import { exploreSkillSource } from "./skill-packs.server";

const sourceSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const gitRevision = /^[a-f0-9]{40}$/u;

const hash = /^[a-f0-9]{64}$/u;

const version = /^\d+\.\d+\.\d+$/u;

const items = new Map<string, PublicSkill>();

for (const record of snapshot) {
  const { category: rawCategory, source, ...fields } = record;
  const category = readPublicSkillCategory(rawCategory);
  const { slug, publisher, sourceUrl, revision, sha256 } = fields;

  if (
    !category ||
    !sourceSlug.test(slug) ||
    !hash.test(sha256) ||
    items.has(slug)
  )
    throw new Error(`Invalid or duplicate public skill: ${slug}`);

  if (source !== "omnyo" && source !== "github")
    throw new Error(`Invalid public skill source: ${slug}`);

  const url = new URL(sourceUrl);

  const setupUrl =
    "setupUrl" in fields && fields.setupUrl
      ? new URL(fields.setupUrl)
      : undefined;

  if (
    setupUrl !== undefined &&
    (source !== "github" ||
      setupUrl.origin !== "https://github.com" ||
      setupUrl.username !== "" ||
      setupUrl.password !== "" ||
      setupUrl.search !== "" ||
      !setupUrl.pathname.startsWith(`/${publisher}/blob/${revision}/`))
  )
    throw new Error(`Invalid public skill setup URL: ${slug}`);

  if (
    "packSlug" in fields &&
    fields.packSlug !== undefined &&
    (source !== "omnyo" ||
      fields.packSlug !== slug ||
      exploreSkillSource(fields.packSlug)?.detail.skills.includes(slug) !==
        true)
  )
    throw new Error(`Invalid public skill pack: ${slug}`);

  if (
    source === "omnyo"
      ? publisher !== "Omnyo" ||
        !version.test(revision) ||
        sourceUrl !==
          `https://omnyohq.com/skills/omnyo/${slug}/${revision}/SKILL.md`
      : !gitRevision.test(revision) ||
        url.origin !== "https://github.com" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !/^[\w.-]+\/[\w.-]+$/u.test(publisher) ||
        !url.pathname.startsWith(`/${publisher}/blob/${revision}/`) ||
        !url.pathname.endsWith("/SKILL.md")
  )
    throw new Error(`Invalid public skill source: ${slug}`);

  items.set(slug, {
    ...fields,
    category,
    source,
    detailPath: publicSkillPath(slug),
  });
}

export const publicSkills = Array.from(items.values());

const publishers = [
  ...new Set(publicSkills.map((item) => item.publisher)),
].sort((left, right) => left.localeCompare(right));

const catalogBody = JSON.stringify({ schemaVersion: 1, items: publicSkills });

export const publicSkillBySlug = (slug: string) => items.get(slug);

export function getPublicSkillPage(search: PublicSkillsSearch) {
  const matches = filterPublicSkills(publicSkills, search);

  const lastPage = Math.max(
    1,
    Math.ceil(matches.length / PUBLIC_SKILLS_PAGE_SIZE),
  );

  const page = Math.min(search.page ?? 1, lastPage);
  const start = (page - 1) * PUBLIC_SKILLS_PAGE_SIZE;

  return {
    items: matches.slice(start, start + PUBLIC_SKILLS_PAGE_SIZE),
    total: matches.length,
    catalogTotal: publicSkills.length,
    publishers,
    page,
    lastPage,
  };
}

export function publicSkillsCatalogResponse() {
  return new Response(catalogBody, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
