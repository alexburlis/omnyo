import { describe, expect, it } from "vitest";
import {
  parseSkillPackImportLink,
  skillPackImportDestination,
  SkillPackImportQueue,
} from "../src/skill-pack-import.js";

const digest = "a".repeat(64);

const deepLink = "omnyo://skills/import/product-update-review/" + digest;

const entry = {
  kind: "import",
  slug: "product-update-review",
  digest,
} as const;

const route =
  "/plugins/skill-discovery/browse/import/product-update-review/" + digest;

describe("Skills handoff", () => {
  it("opens the exact Marketplace source in the same Skills panel", () => {
    const item = parseSkillPackImportLink(
      `omnyo://skills/source/example-skill/${digest}`,
    );

    expect(item).toEqual({ kind: "source", slug: "example-skill", digest });

    if (!item) throw new Error("Expected the marketplace import.");

    expect(skillPackImportDestination("https://connected.example", item)).toBe(
      `https://connected.example/plugins/skill-discovery/browse/source/example-skill/${digest}`,
    );
    expect(
      parseSkillPackImportLink(
        `omnyo://skills/source/${"x".repeat(161)}/${digest}`,
      ),
    ).toBeNull();
  });
  it("carries the pinned revision to the connected coordinator without URL overrides", () => {
    expect(parseSkillPackImportLink(deepLink)).toEqual(entry);
    expect(
      skillPackImportDestination(
        "https://connected.example/workspace/?from=choose#top",
        entry,
      ),
    ).toBe("https://connected.example/workspace" + route);
    expect(() =>
      skillPackImportDestination(
        "https://owner:secret@connected.example",
        entry,
      ),
    ).toThrow();
    expect(() =>
      skillPackImportDestination("file:///workspace", entry),
    ).toThrow();
  });

  it.each(["/extra", "?destination=other", "#open", "%0a"])(
    "rejects a suffixed link %s",
    (suffix) => {
      expect(parseSkillPackImportLink(deepLink + suffix)).toBeNull();
    },
  );

  it("rejects URLs which are ambiguous, malformed, unpinned, or from a different import", () => {
    for (const link of [
      "https://skills/import/product-update-review/" + digest,
      "omnyo://skills/import/%2e%2e/" + digest,
      "omnyo://skills/import/alpha--beta/" + digest,
      "omnyo://skills/import/" + "x".repeat(65) + "/" + digest,
      "omnyo://skills/import/product-update-review/" + "f".repeat(63),
      "omnyo://workflows/import/" + "a".repeat(32),
    ])
      expect(parseSkillPackImportLink(link)).toBeNull();
  });

  it("retains the pending request across a load failure, then consumes it once", async () => {
    const queue = new SkillPackImportQueue();
    queue.add(entry);
    await expect(
      queue.open("http://localhost:38886", async () => {
        throw new Error("Loading failed");
      }),
    ).rejects.toThrow("Loading failed");
    const opened: string[] = [];

    const load = async (url: string) => {
      opened.push(url);
    };

    await queue.open("http://localhost:38886", load);
    await queue.open("http://localhost:38886", load);
    expect(opened).toEqual(["http://localhost:38886" + route]);
  });
});
