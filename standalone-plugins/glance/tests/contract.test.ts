import { describe, expect, it } from "vitest";
import { cardSchema, type CardInput } from "../contract.ts";

function card(): CardInput {
  return { status: "working", phase: "build", headline: "The card is being built" };
}

describe("card boundary", () => {
  it("accepts an explicitly owned raster preview independently of its deliverable link", () => {
    const result = cardSchema.parse({
      ...card(),
      deliverables: [
        {
          title: "Updated page",
          href: "https://example.com/preview.html",
          preview: {
            kind: "project-image",
            projectId: "project-other",
            path: "uploads/result.png",
            mimeType: "image/png",
            alt: "Updated narrow layout",
            visualRequestId: "visual-1",
            role: "result",
          },
        },
      ],
    });

    expect(result.deliverables[0]?.preview).toMatchObject({
      projectId: "project-other",
      path: "uploads/result.png",
    });
  });

  it.each([
    "/Users/me/result.png",
    "../result.png",
    "uploads/../result.png",
    "uploads\\result.png",
    "file:result.png",
    "https://example.com/result.png",
  ])("refuses an ambiguous preview path %s", (path) => {
    expect(
      cardSchema.safeParse({
        ...card(),
        deliverables: [
          {
            title: "Result",
            href: "result.html",
            preview: {
              kind: "project-image",
              projectId: "project-other",
              path,
              mimeType: "image/png",
              alt: "Result",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses active image formats and copied image bytes in preview metadata", () => {
    expect(
      cardSchema.safeParse({
        ...card(),
        deliverables: [
          {
            title: "Result",
            href: "result.html",
            preview: {
              kind: "project-image",
              projectId: "project-other",
              path: "uploads/result.svg",
              mimeType: "image/svg+xml",
              alt: "Result",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      cardSchema.safeParse({
        ...card(),
        deliverables: [
          {
            title: "Result",
            href: "result.html",
            preview: {
              kind: "project-image",
              projectId: "project-other",
              path: "uploads/result.png",
              mimeType: "image/png",
              alt: "Result",
              bytes: "base64",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    { status: "working", ask: { question: "Choose a version" } },
    { status: "needs-you", ask: { question: "Choose a version", recommended: "A" } },
    {
      status: "needs-you",
      ask: { question: "Choose a version", options: ["A"], recommended: "B" },
    },
    { status: "blocked" },
    { status: "blocked", blocker: "   " },
    { blocker: "A missing decision" },
    { proof: [{ kind: "reproduced", claim: "Tests passed" }] },
    { proof: [{ kind: "reproduced", claim: "Tests passed", command: "pnpm test", eventSeq: 0 }] },
    { deliverables: [{ title: "Unsafe", href: "javascript:alert(1)" }] },
    { deliverables: [{ title: "Unsafe", href: "http://example.com" }] },
    { headline: "Two\nlines" },
    { sidebarSummary: "Build passed" },
    { status: "done", sidebarSummary: "x".repeat(65) },
    { status: "done", sidebarSummary: "Two\nlines" },
    { status: "done", sidebarSummary: "   " },
  ])("refuses an inconsistent or unsafe card: %j", (change) => {
    expect(cardSchema.safeParse({ ...card(), ...change }).success).toBe(false);
  });

  it("accepts attention status without a decision payload, explicit proof selector and safe file/web links", () => {
    const result = cardSchema.parse({
      ...card(),
      status: "needs-you",
      proof: [
        { claim: "The command completed", kind: "reproduced", command: "pnpm test", eventSeq: 12 },
      ],
      deliverables: [
        { title: "Report", href: "/Users/me/report.md" },
        { title: "Source", href: "docs/report.md" },
        { title: "Website", href: "https://example.com/report" },
      ],
    });

    expect(result.status).toBe("needs-you");
    expect(result.proof[0]?.eventSeq).toBe(12);
    expect(result.facts).toEqual([]);
  });
});
