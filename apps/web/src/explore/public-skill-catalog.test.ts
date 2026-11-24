import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  getPublicSkillPage,
  publicSkillBySlug,
  publicSkills,
  publicSkillsCatalogResponse,
} from "./public-skill-catalog.server";
import {
  PUBLIC_SKILLS_PAGE_SIZE,
  publicSkillsHref,
  validatePublicSkillsSearch,
} from "./public-skills";

describe("public Explore skills", () => {
  it("publishes pinned upstream links and the exact public edition files", async () => {
    const external = publicSkills.filter((skill) => skill.source === "github");
    const owned = publicSkills.filter((skill) => skill.source === "omnyo");

    expect(external).toHaveLength(501);
    expect(owned).toHaveLength(17);
    expect(new Set(publicSkills.map((skill) => skill.slug)).size).toBe(518);

    for (const skill of external) {
      expect(skill.sourceUrl).toMatch(
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[a-f0-9]{40}\/.+\/SKILL\.md$/u,
      );
    }

    for (const skill of owned) {
      const path = new URL(skill.sourceUrl).pathname;

      const bytes = readFileSync(
        new URL(`../../public${path}`, import.meta.url),
      );

      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        skill.sha256,
      );
      expect(bytes.toString()).toContain(`\nname: ${skill.slug}\n`);
      expect(bytes.toString()).toContain("\nlicense: MIT\n");
    }

    const response = publicSkillsCatalogResponse();
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      items: publicSkills,
    });
  });

  it("keeps exact filters in paged links and handles an unmatched request", () => {
    const search = validatePublicSkillsSearch({
      q: "  font   optimization ",
      category: "Design & UI",
      publisher: "Omnyo",
      page: "50000",
    });

    const found = getPublicSkillPage(search);

    expect(found.items.map((skill) => skill.slug)).toEqual([
      "web-font-optimization",
    ]);
    expect(found).toMatchObject({
      total: 1,
      catalogTotal: 518,
      page: 1,
      lastPage: 1,
    });
    expect(publicSkillsHref(search)).toBe(
      "/explore/skills?q=font+optimization&category=Design+%26+UI&publisher=Omnyo&page=50000",
    );
    expect(getPublicSkillPage({}).items).toHaveLength(PUBLIC_SKILLS_PAGE_SIZE);
    expect(getPublicSkillPage({ q: "absent-b1bf2baf15" }).items).toEqual([]);
    expect(publicSkillBySlug("unknown-skill")).toBeUndefined();
    expect(
      validatePublicSkillsSearch({
        page: -5,
        publisher: "//other",
        category: "unknown",
      }),
    ).toEqual({});
  });
});
