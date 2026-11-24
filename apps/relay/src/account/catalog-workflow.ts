import { createHash } from "node:crypto";
import weeklyRelease from "../../../web/src/workflow-catalog/weekly-content-feed.release.json" with { type: "json" };
import { WORKFLOW_SHARE_MAX_BYTES } from "../workflow-shares.js";

export const weeklyCatalogShareId = weeklyRelease.sha256.slice(0, 32);

export async function readPublishedWeeklyFeed() {
  const response = await fetch(
    `https://omnyohq.com/workflows/weekly-content-feed/file/${weeklyRelease.sha256}`,
    { redirect: "error", signal: AbortSignal.timeout(8000) },
  );

  if (response.status === 404) {
    await response.body?.cancel();

    return null;
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The workflow catalog is unavailable.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.length;

      if (size > WORKFLOW_SHARE_MAX_BYTES)
        throw new Error("Catalog workflow exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }

  const bytes = Buffer.concat(chunks, size);

  if (createHash("sha256").update(bytes).digest("hex") !== weeklyRelease.sha256)
    throw new Error(
      "The catalog workflow does not match its published digest.",
    );

  return bytes;
}
