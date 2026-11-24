import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { inspectWorkflowPackage } from "../../../plugins/automations/src/workflow-package.js";
import builtin from "../../../plugins/automations/workflow-fixtures/weekly-content-feed.json";
import {
  workflowAttachmentPath,
  workflowListingPath,
} from "./workflow-catalog/catalog";
import {
  createWorkflowCatalog,
  type CatalogEntry,
} from "./workflow-catalog/catalog.server";
import { workflowEntries } from "./workflow-catalog/entries.server";
import weeklyBytes from "./workflow-catalog/weekly-content-feed.omnyoworkflow?raw";
import weeklyRelease from "./workflow-catalog/weekly-content-feed.release.json";

const [weeklyEntry] = workflowEntries;

const { slug } = weeklyEntry.listing;

const DIGEST = weeklyRelease.sha256;

const published: CatalogEntry = { ...weeklyEntry, state: "published" };

const encode = (data: string) => new TextEncoder().encode(data);

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

describe("public workflow catalog", () => {
  it("uses the canonical built-in bytes and the matching public summary", async () => {
    const [editable, downloadable] = await Promise.all([
      inspectWorkflowPackage(encode(JSON.stringify(builtin))),
      inspectWorkflowPackage(encode(weeklyBytes)),
    ]);

    expect(encode(weeklyBytes)).toEqual(editable.canonicalBytes);
    expect(downloadable.canonicalBytes).toEqual(editable.canonicalBytes);
    expect(downloadable.packageDigest).toBe(DIGEST);
    expect(sha256(downloadable.canonicalBytes)).toBe(DIGEST);
    expect(downloadable.package.templateId).toBe(slug);
    expect(downloadable.package.revision).toBe(weeklyRelease.revision);
    const { flow } = downloadable.package;
    expect(flow).toMatchObject({
      kind: "graph",
      engine: "weekly-content-feed",
    });

    if (flow.kind !== "graph" || flow.engine !== "weekly-content-feed")
      throw new Error("Expected the shipped weekly graph");
    expect(weeklyRelease.candidateBudget).toEqual({
      target: flow.targetCount,
      limit: flow.maxCandidates,
    });
    expect(weeklyRelease.capabilities).toEqual(downloadable.capabilities);
    expect(weeklyRelease.inputs).toEqual(
      downloadable.package.inputs.map(({ id, label, type }) => ({
        id,
        label,
        type,
      })),
    );
    expect(downloadable.package.trigger).toEqual({
      kind: "weekly",
      time: "09:00",
      timezone: "America/Toronto",
      weekday: 1,
    });
    expect(weeklyRelease.schedule).toEqual({
      cron: "0 9 * * 1",
      tz: "America/Toronto",
    });
  });

  it("excludes the draft listing, exact artifact and image from public discovery", async () => {
    const draft = createWorkflowCatalog([{ ...weeklyEntry, state: "draft" }]);

    expect(draft.listings).toEqual([]);
    expect(draft.sitemapPaths).toEqual([]);
    expect(draft.detail(slug)).toBeUndefined();
    expect((await draft.attachment(slug, DIGEST)).status).toBe(404);
    expect(draft.previewImage(slug).status).toBe(404);
  });

  it("publishes only the curated listing and serves the pinned file with download headers", async () => {
    const catalog = createWorkflowCatalog([published]);

    expect(catalog.sitemapPaths).toEqual([
      "/workflows",
      workflowListingPath(slug),
    ]);
    expect(catalog.listings.map(({ slug }) => slug)).toEqual([slug]);
    const detail = catalog.detail(slug);
    expect(detail?.release.sha256).toBe(DIGEST);
    const path = workflowAttachmentPath(slug, DIGEST);
    const file = await catalog.attachment(slug, path.split("/").at(-1) ?? "");

    expect(file.status).toBe(200);
    expect(Object.fromEntries(file.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition":
        'attachment; filename="weekly-content-feed.omnyoworkflow"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      encode(weeklyBytes),
    );
    const image = catalog.previewImage(slug);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("no-store");
    const imageBytes = Buffer.from(await image.arrayBuffer());
    expect(imageBytes.subarray(1, 4).toString()).toBe("PNG");
    expect(imageBytes.readUInt32BE(16)).toBe(1200);
    expect(imageBytes.readUInt32BE(20)).toBe(630);
  });

  it("serves a stale page's pinned file across a revision and returns 410 after withdrawal", async () => {
    const nextRevision = weeklyRelease.revision + 1;

    const next = await inspectWorkflowPackage(
      encode(JSON.stringify({ ...builtin, revision: nextRevision })),
    );

    const current = {
      state: "current",
      summary: {
        ...weeklyRelease,
        revision: nextRevision,
        sha256: next.packageDigest,
      },
      canonical: new TextDecoder().decode(next.canonicalBytes),
    } as const;

    const retained = {
      state: "superseded",
      summary: weeklyRelease,
      canonical: weeklyBytes,
    } as const;

    const updated = createWorkflowCatalog([
      { ...published, releases: [current, retained] },
    ]);

    expect(updated.detail(slug)?.release.revision).toBe(nextRevision);
    expect(await (await updated.attachment(slug, DIGEST)).text()).toBe(
      weeklyBytes,
    );

    const withdrawn = createWorkflowCatalog([
      {
        ...published,
        releases: [current, { state: "withdrawn", summary: weeklyRelease }],
      },
    ]);

    const retired = await withdrawn.attachment(slug, DIGEST);

    expect(retired.status).toBe(410);
    expect(retired.headers.get("cache-control")).toBe("no-store");
    expect((await withdrawn.attachment(slug, next.packageDigest)).status).toBe(
      200,
    );
    expect(
      (await createWorkflowCatalog([]).attachment(slug, DIGEST)).status,
    ).toBe(404);
  });

  it("refuses unknown slugs, mismatched digests and corrupt bytes", async () => {
    const catalog = createWorkflowCatalog([published]);

    const corrupt = createWorkflowCatalog([
      {
        ...published,
        releases: [
          { state: "current", summary: weeklyRelease, canonical: "unexpected" },
        ],
      },
    ]);

    expect(catalog.detail("unknown")).toBeUndefined();
    expect(
      (await catalog.attachment("../weekly-content-feed", DIGEST)).status,
    ).toBe(404);
    expect((await catalog.attachment(slug, DIGEST.toUpperCase())).status).toBe(
      404,
    );
    expect((await catalog.attachment(slug, "0".repeat(64))).status).toBe(404);
    expect((await corrupt.attachment(slug, DIGEST)).status).toBe(500);
  });

  it("rejects duplicate slugs, duplicate revisions or digests, and ambiguous current releases", () => {
    const [current] = published.releases;
    expect(() => createWorkflowCatalog([published, published])).toThrow(
      /slug/u,
    );

    for (const duplicate of [
      { ...weeklyRelease, sha256: "0".repeat(64) },
      { ...weeklyRelease, revision: weeklyRelease.revision + 1 },
    ]) {
      expect(() =>
        createWorkflowCatalog([
          {
            ...published,
            releases: [
              current,
              {
                state: "superseded",
                summary: duplicate,
                canonical: weeklyBytes,
              },
            ],
          },
        ]),
      ).toThrow(/duplicate workflow release/u);
    }

    expect(() =>
      createWorkflowCatalog([{ ...published, releases: [] }]),
    ).toThrow(/one current/u);
    expect(() =>
      createWorkflowCatalog([
        {
          ...published,
          releases: [
            current,
            {
              state: "current",
              summary: {
                ...weeklyRelease,
                revision: weeklyRelease.revision + 1,
                sha256: "0".repeat(64),
              },
              canonical: weeklyBytes,
            },
          ],
        },
      ]),
    ).toThrow(/one current/u);
  });
});
