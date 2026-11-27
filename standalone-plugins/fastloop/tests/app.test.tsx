import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetailsView, type JobView, type EvidenceView } from "../details.js";
import { loadPreview, type previewChunkSchema } from "../preview.js";
import type { z } from "zod";

function job(verdict: "PASSED" | "FAILED" | "INCONCLUSIVE", exploration = false): JobView {
  return {
    runId: "run-1",
    state: "completed",
    lastEventSequence: 5,
    result: {
      sessionId: "session-1",
      verdict,
      completion: exploration ? "exploration_completed" : "objective_completed",
      scope: ["Saved names survive reload"],
      checks: [
        {
          checkId: "persisted-name",
          status: verdict === "PASSED" ? "PASS" : "FAIL",
          assessment: "deterministic",
          reasonCode: "VALUE_MISMATCH",
          evidenceIds: [],
        },
        {
          checkId: "visible-cta",
          status: "UNKNOWN",
          assessment: "model_assessed",
          reasonCode: "VISUAL_UNCERTAIN",
          evidenceIds: [],
        },
      ],
      evidence: [],
      observations: [],
      limitations: ["Fresh build identity unavailable"],
      requirementsHash: "a".repeat(64),
      checksHash: "b".repeat(64),
    },
  };
}

describe("FastLoop result presentation", () => {
  it("explains a blocked provider run once without exposing internal error codes", () => {
    const blocked = job("INCONCLUSIVE");

    if (!blocked.result) throw new Error("RESULT_REQUIRED");
    blocked.result.verdict = "BLOCKED";
    blocked.result.checks = [];
    blocked.result.observations = ["MODEL_RATE_LIMITED"];
    blocked.result.limitations = ["MODEL_RATE_LIMITED"];

    const html = renderToStaticMarkup(
      <RunDetailsView job={blocked} busy={false} onCancel={() => {}} onEvidence={() => {}} />,
    );

    expect(html).toContain("<h3>Blocked</h3>");
    expect(html.match(/The model provider rate limited this run/g)).toHaveLength(1);
    expect(html).not.toContain("MODEL_RATE_LIMITED");
  });
  it("shows the failed requirement, tested scope and model assessment without inventing a pass", () => {
    const html = renderToStaticMarkup(
      <RunDetailsView job={job("FAILED")} busy={false} onCancel={() => {}} onEvidence={() => {}} />,
    );

    expect(html).toContain("<h3>Failed</h3>");
    expect(html).toContain("Saved names survive reload");
    expect(html).toContain("Visual model assessment");
    expect(html).toContain("value mismatch");
    expect(html).toContain("Fresh build identity unavailable");
    expect(html).not.toContain("<h3>Passed</h3>");
  });
  it("labels exploratory completion as partial coverage and preserves a demonstrated failure", () => {
    const incomplete = renderToStaticMarkup(
      <RunDetailsView
        job={job("INCONCLUSIVE", true)}
        busy={false}
        onCancel={() => {}}
        onEvidence={() => {}}
      />,
    );

    const failed = renderToStaticMarkup(
      <RunDetailsView
        job={job("FAILED", true)}
        busy={false}
        onCancel={() => {}}
        onEvidence={() => {}}
      />,
    );

    expect(incomplete).toContain("Exploration completed");
    expect(incomplete).toContain("Coverage is partial");
    expect(incomplete).not.toContain("<h3>Passed</h3>");
    expect(failed).toContain("<h3>Failed</h3>");
  });
  it("offers cancellation for active work without showing a fabricated terminal verdict", () => {
    const html = renderToStaticMarkup(
      <RunDetailsView
        job={{ runId: "active-1", state: "running", lastEventSequence: 2 }}
        busy
        onCancel={() => {}}
        onEvidence={() => {}}
      />,
    );

    expect(html).toContain("Verification in progress");
    expect(html).toContain("Cancel run");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Passed");
  });
});

const payload = Buffer.from("<script>untrusted page text</script>");

const evidence: EvidenceView = {
  id: "evidence-1",
  runId: "run-1",
  kind: "trace",
  relativePath: "report.md",
  redacted: true,
  sha256: createHash("sha256").update(payload).digest("hex"),
};

function chunk(offset = 0, end = payload.length): z.infer<typeof previewChunkSchema> {
  return {
    evidenceId: evidence.id,
    evidence: { ...evidence, redacted: true },
    offset,
    totalBytes: payload.length,
    bytesBase64: payload.subarray(offset, end).toString("base64"),
    mimeType: "text/markdown",
    complete: end === payload.length,
  };
}

describe("verified browser artifact preview", () => {
  it("reassembles bounded owned chunks and treats page markup as inert text", async () => {
    const offsets: number[] = [];

    const result = await loadPreview(
      evidence,
      async (offset) => {
        offsets.push(offset);

        return chunk(offset, offset === 0 ? 8 : payload.length);
      },
      new AbortController().signal,
    );

    expect(offsets).toEqual([0, 8]);
    expect(result.mimeType).toBe("text/plain");
    expect(new TextDecoder().decode(result.bytes)).toBe(payload.toString());
  });
  it.each([
    {
      name: "foreign run",
      value: { ...chunk(), evidence: { ...chunk().evidence, runId: "other-run" } },
      error: "PREVIEW_IDENTITY_CHANGED",
    },
    {
      name: "changed bytes",
      value: { ...chunk(), bytesBase64: Buffer.alloc(payload.length, 65).toString("base64") },
      error: "PREVIEW_HASH_MISMATCH",
    },
    {
      name: "HTML execution type",
      value: { ...chunk(), mimeType: "text/html" },
      error: "PREVIEW_TYPE_UNSUPPORTED",
    },
    { name: "offset gap", value: { ...chunk(), offset: 1 }, error: "PREVIEW_IDENTITY_CHANGED" },
    {
      name: "early completion",
      value: { ...chunk(0, 8), complete: true },
      error: "PREVIEW_CHUNK_INVALID",
    },
  ])("refuses $name", async ({ value, error }) => {
    await expect(
      loadPreview(evidence, async () => value, new AbortController().signal),
    ).rejects.toThrow(error);
  });
  it("makes no read for withheld evidence or a closed viewer", async () => {
    let reads = 0;

    const read = async () => {
      reads += 1;

      return chunk();
    };

    await expect(
      loadPreview({ ...evidence, redacted: false }, read, new AbortController().signal),
    ).rejects.toThrow("PREVIEW_WITHHELD");
    await expect(loadPreview(evidence, read, AbortSignal.abort())).rejects.toThrow(
      "PREVIEW_CLOSED",
    );
    expect(reads).toBe(0);
  });
});
