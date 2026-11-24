import { describe, expect, it } from "vitest";
import {
  getMarkdownCodeLanguage,
  isMarkdownCodeBlock,
} from "./markdown-code-block";

describe("getMarkdownCodeLanguage", () => {
  it("reads the language class from a react-markdown code fence", () => {
    expect(getMarkdownCodeLanguage({ className: "language-mermaid" })).toBe(
      "mermaid",
    );
    expect(
      getMarkdownCodeLanguage({
        className: "hljs language-TypeScript extra-class",
      }),
    ).toBe("typescript");
  });

  it("returns null when there is no language class", () => {
    expect(getMarkdownCodeLanguage({ className: undefined })).toBeNull();
    expect(getMarkdownCodeLanguage({ className: "font-mono" })).toBeNull();
    expect(getMarkdownCodeLanguage({ className: "language-" })).toBeNull();
  });
});

describe("isMarkdownCodeBlock", () => {
  it("treats language-tagged code as a block", () => {
    expect(
      isMarkdownCodeBlock({ codeText: "graph TD; A-->B", language: "mermaid" }),
    ).toBe(true);
  });

  it("treats multiline untagged code as a block", () => {
    expect(isMarkdownCodeBlock({ codeText: "one\ntwo", language: null })).toBe(
      true,
    );
  });

  it("keeps inline math inline while KaTeX is still loading", () => {
    expect(
      isMarkdownCodeBlock({
        className: "language-math math-inline",
        codeText: "E = mc^2",
        language: "math",
      }),
    ).toBe(false);
    expect(
      isMarkdownCodeBlock({
        className: "language-math math-display",
        codeText: "x^2",
        language: "math",
      }),
    ).toBe(true);
  });

  it("keeps inline code containing mermaid as inline code", () => {
    expect(isMarkdownCodeBlock({ codeText: "mermaid", language: null })).toBe(
      false,
    );
  });
});
