import { randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import type { z } from "zod";
import {
  decodeSkillPack,
  encodeSkillPack,
  packArtifact,
  type PackArtifact,
} from "./pack-encoding.ts";
import { curatedEntries, curatedPackArtifact, loadCuratedFiles } from "./curated-artifacts.ts";
import { markdownSkillPack } from "./markdown-import.ts";
import { marketplaceOrigin } from "./marketplace-contract.ts";
import {
  marketplaceMarkdownUrl,
  matchReviewedSkills,
  readMarketplace,
} from "./marketplace-service.ts";
import { packHostContract } from "./pack-host-contract.ts";
import { maxPackBytes, packConfirmInput, packReviewInput, type SkillPack } from "./pack.ts";

const reviewTtl = 15 * 60 * 1000;

const maximumReviews = 24;

type Workspace = { projectId: string; environmentId: string | null };

type ReviewRequest = z.infer<typeof packReviewInput>;

interface Target {
  workspacePath: string;
  hostId: string;
}

interface Review {
  workspace: Workspace;
  target: Target;
  workspaceIdentity: string;
  artifact: PackArtifact;
  pack: SkillPack;
  expires: number;
}

export async function resolvePackWorkspace(
  sdk: Pick<PluginApi["sdk"], "projects" | "environments">,
  workspace: Workspace,
): Promise<Target> {
  if (workspace.environmentId !== null) {
    const environment = await sdk.environments.get({ environmentId: workspace.environmentId });

    if (environment.projectId !== workspace.projectId) {
      throw new Error("The selected workspace does not belong to the destination project.");
    }

    if (environment.path) return { workspacePath: environment.path, hostId: environment.hostId };
  } else {
    const project = await sdk.projects.get({ projectId: workspace.projectId });
    const source = project.sources.find((item) => item.isDefault);

    if (source?.hostId && source.path) return { workspacePath: source.path, hostId: source.hostId };
  }

  throw new Error("Choose a project workspace with an existing folder for the skill pack.");
}

export async function loadPackArtifact(
  source: ReviewRequest["source"],
  request: typeof fetch = fetch,
): Promise<PackArtifact> {
  if (source.kind === "local") return packArtifact(source.text);

  if (source.kind === "markdown") return encodeSkillPack(markdownSkillPack(source));

  if (source.kind === "marketplace") {
    const catalog = await readMarketplace(request);

    const item = catalog.items.find(
      (entry) => entry.kind === "skill" && entry.slug === source.slug,
    );

    if (item?.kind !== "skill" || item.sha256 !== source.digest)
      throw new Error("This marketplace skill changed. Open its current listing and review again.");

    if (item.setupUrl !== undefined)
      throw new Error("This skill requires the provider setup in its Marketplace listing.");

    const url = marketplaceMarkdownUrl(item);

    const reviewedId = matchReviewedSkills({ schemaVersion: 1, items: [item] }, curatedEntries)[
      item.slug
    ];

    const entry = curatedEntries.find((candidate) => candidate.id === reviewedId);

    if (entry) return curatedPackArtifact(entry, await loadCuratedFiles(entry));

    const text = await readSkillText(url, request, "text/markdown, text/plain");

    if (packArtifact(text).digest !== source.digest)
      throw new Error("The Markdown contents do not match the marketplace SHA-256 digest.");

    return encodeSkillPack(
      markdownSkillPack({
        filename: `${source.slug}.md`,
        text,
        license: item.license,
        allowPlain: false,
      }),
    );
  }

  const url = new URL(`/explore/skills/${source.slug}/file/${source.digest}`, marketplaceOrigin);

  return { text: await readSkillText(url, request, "application/json"), digest: source.digest };
}

async function readSkillText(url: URL, request: typeof fetch, accept: string) {
  const response = await request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { accept },
  });

  if (!response.ok || response.body === null) throw new Error("This skill release is unavailable.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) break;

      length += result.value.byteLength;

      if (length > maxPackBytes) {
        await reader.cancel();
        throw new Error("Skill pack exceeds 768 KiB.");
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks, length),
  );
}

export function createPackService(api: PluginApi) {
  const host = api.hosts.experimental_client({ contract: packHostContract });
  const reviews = new Map<string, Review>();

  async function reviewArtifact(workspace: Workspace, artifact: PackArtifact, target: Target) {
    const pack = decodeSkillPack(artifact);

    const { workspaceIdentity, destination, receipt } = await host.call(
      "inspect",
      { workspacePath: target.workspacePath, artifact },
      { hostId: target.hostId },
    );

    const now = Date.now();

    for (const [id, pending] of reviews) if (pending.expires <= now) reviews.delete(id);

    if (reviews.size >= maximumReviews)
      throw new Error("Too many active pack reviews. Try again when a review expires.");

    const reviewId = randomUUID();

    reviews.set(reviewId, {
      workspace,
      target,
      workspaceIdentity,
      artifact,
      pack,
      expires: now + reviewTtl,
    });

    return {
      ...workspace,
      reviewId,
      digest: artifact.digest,
      pack,
      destination,
      receipt,
      workspacePath: target.workspacePath,
    };
  }

  return {
    async reviewArtifact(workspace: Workspace, artifact: PackArtifact) {
      const target = await resolvePackWorkspace(api.sdk, workspace);

      return reviewArtifact(workspace, artifact, target);
    },
    async review(value: ReviewRequest) {
      const { projectId, environmentId, source } = packReviewInput.parse(value);
      const workspace = { projectId, environmentId };

      const [artifact, target] = await Promise.all([
        loadPackArtifact(source),
        resolvePackWorkspace(api.sdk, workspace),
      ]);

      if (source.kind === "published") {
        const pack = decodeSkillPack(artifact);

        if (pack.slug !== source.slug || pack.publisher !== "omnyo")
          throw new Error("The published pack identity does not match the selected listing.");
      }

      return reviewArtifact(workspace, artifact, target);
    },
    async confirm(value: z.infer<typeof packConfirmInput>) {
      const { reviewId, digest } = packConfirmInput.parse(value);
      const review = reviews.get(reviewId);

      if (!review || review.expires <= Date.now() || review.artifact.digest !== digest) {
        throw new Error("The pack review expired or changed. Review the pack again.");
      }

      const target = await resolvePackWorkspace(api.sdk, review.workspace);

      if (
        target.hostId !== review.target.hostId ||
        target.workspacePath !== review.target.workspacePath
      ) {
        throw new Error("The destination workspace changed. Review the pack again.");
      }

      const { receipt } = await host.call(
        "install",
        {
          workspacePath: target.workspacePath,
          workspaceIdentity: review.workspaceIdentity,
          artifact: review.artifact,
        },
        { hostId: target.hostId, timeoutMs: 45_000 },
      );

      return { ...review.workspace, digest, pack: review.pack, receipt };
    },
  };
}
