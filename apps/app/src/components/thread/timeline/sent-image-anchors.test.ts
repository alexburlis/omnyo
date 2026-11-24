import { describe, expect, it } from "vitest";
import type { PromptTextMention } from "@omnyo/domain";
import { pairSentImageAnchors } from "./sent-image-anchors";

function anchor(
  text: string,
  label: string,
  path: string,
  from = 0,
): PromptTextMention {
  const start = text.indexOf(`[${label}]`, from);

  return {
    start,
    end: start + label.length + 2,
    resource: { kind: "attachment", path, label },
  };
}

describe("pairSentImageAnchors", () => {
  it("labels images in the order of their first anchors", () => {
    const text = "Compare [Img2] with [Img1], then [Img2] again";

    expect(
      pairSentImageAnchors({
        text,
        mentions: [
          anchor(text, "Img1", "b.png"),
          anchor(text, "Img2", "a.png"),
          anchor(text, "Img2", "a.png", 30),
        ],
        localImagePaths: ["a.png", "b.png", "legacy.png"],
      }),
    ).toEqual(["Img2", "Img1", null]);
  });

  it("stops pairing at the first position whose path does not match", () => {
    const text = "[Img1] and [Img2]";

    expect(
      pairSentImageAnchors({
        text,
        mentions: [
          anchor(text, "Img1", "a.png"),
          anchor(text, "Img2", "b.png"),
        ],
        localImagePaths: ["b.png", "a.png"],
      }),
    ).toEqual([null, null]);
  });

  it("ignores typed lookalike text and non-image attachment mentions", () => {
    const text = "Typed [Img1] and @notes.md";
    const start = text.indexOf("@notes.md");

    expect(
      pairSentImageAnchors({
        text,
        mentions: [
          {
            start,
            end: start + 9,
            resource: {
              kind: "attachment",
              path: "notes.md",
              label: "notes.md",
            },
          },
        ],
        localImagePaths: ["a.png"],
      }),
    ).toEqual([null]);
  });
});
