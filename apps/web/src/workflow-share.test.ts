import { describe, expect, it } from "vitest";
import { workflowSharePage } from "./workflow-share";

const ID = "a".repeat(32);

describe("public workflow landing", () => {
  it("bounds the destination, escapes metadata and uses neutral previews", async () => {
    const urls: string[] = [];

    const response = await workflowSharePage(ID, async (input) => {
      urls.push(String(input));

      return Response.json({
        id: ID,
        title: "<script>attack</script>",
        description: "![remote](https://bad.invalid/track)",
        capabilities: ["model-text"],
      });
    });

    const html = await response.text();
    expect(urls).toEqual([`https://omnyo.link/api/workflow-shares/${ID}`]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain(`omnyo://workflows/import/${ID}`);
    expect(html).toContain("<title>Shared workflow — Omnyo</title>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("denies invalid IDs, revoked links and oversize metadata", async () => {
    expect((await workflowSharePage("https://bad.invalid")).status).toBe(404);
    expect(
      (
        await workflowSharePage(
          ID,
          async () => new Response(null, { status: 404 }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await workflowSharePage(ID, async () => new Response("x".repeat(8193))))
        .status,
    ).toBe(503);
  });
});
