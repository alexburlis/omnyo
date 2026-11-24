import { createHash } from "node:crypto";

import customerLab from "./customer-lab.json";
import customerLabBytes from "./customer-lab.json?raw";
import productUpdateReview from "./product-update-review.json";
import productUpdateReviewBytes from "./product-update-review.json?raw";

const SHA256 = /^[a-f0-9]{64}$/u;

interface SkillPackManifest {
  slug: string;
  title: string;
  description: string;
  publisher: string;
  version: string;
  license: string;
  skills: readonly { id: string }[];
  prompts: readonly { title: string }[];
}

type SkillPackRelease = { sha256: string } & (
  | {
      state: "current" | "superseded";
      manifest: SkillPackManifest;
      bytes: string;
    }
  | { state: "withdrawn" }
);

export interface SkillPackResearch {
  title: string;
  url: string;
  description: string;
}

export function createExploreSkillSource(
  releases: readonly SkillPackRelease[],
  research?: SkillPackResearch,
) {
  const byDigest = new Map<string, SkillPackRelease>();
  const versions = new Set<string>();
  const current = releases.find((release) => release.state === "current");

  if (!current || current.state !== "current") {
    throw new Error("A listed skill pack requires a current release.");
  }

  const { manifest } = current;

  for (const release of releases) {
    const { sha256 } = release;

    if (!SHA256.test(sha256) || byDigest.has(sha256)) {
      throw new Error(
        `Invalid or duplicate digest in skill pack ${manifest.slug}.`,
      );
    }

    if (release.state !== "withdrawn") {
      const digest = createHash("sha256").update(release.bytes).digest("hex");

      if (
        digest !== sha256 ||
        release.manifest.slug !== manifest.slug ||
        release.manifest.publisher !== manifest.publisher ||
        versions.has(release.manifest.version) ||
        (release.state === "current" && release !== current)
      ) {
        throw new Error(`Invalid release in skill pack ${manifest.slug}.`);
      }

      versions.add(release.manifest.version);
    }

    byDigest.set(sha256, release);
  }

  return {
    slug: manifest.slug,
    detail: {
      title: manifest.title,
      summary: manifest.description,
      publisher: manifest.publisher,
      version: manifest.version,
      sha256: current.sha256,
      license: manifest.license,
      skills: manifest.skills.map(({ id }) => id),
      prompts: manifest.prompts.map(({ title }) => title),
      ...(research === undefined ? {} : { research }),
    },
    release: (sha256: string) => byDigest.get(sha256),
  };
}

export type ExploreSkillSource = ReturnType<typeof createExploreSkillSource>;

const productUpdateReviewSource = createExploreSkillSource([
  {
    state: "current",
    sha256: "74f95c49f835bd54e06e4a8706240e0802ff81ca7ec3b469db55b2fa36a97cfc",
    manifest: productUpdateReview,
    bytes: productUpdateReviewBytes,
  },
]);

const customerLabSource = createExploreSkillSource(
  [
    {
      state: "current",
      sha256:
        "43b8639bcb9cd2d1d66904559403aa06822671039411316e4f0738fd06f6e414",
      manifest: customerLab,
      bytes: customerLabBytes,
    },
  ],
  {
    title:
      "Semantic similarity rating for purchase intent (Maier et al., 2025)",
    url: "https://arxiv.org/pdf/2510.08338",
    description:
      "The Buyer Offer Panel’s optional scoring adapts the paper’s semantic similarity rating method. Use simulated reactions to find questions to test with real buyers.",
  },
);

const skillSources = [productUpdateReviewSource, customerLabSource];

export const exploreSkillSource = (slug: string) =>
  skillSources.find((source) => source.slug === slug);
