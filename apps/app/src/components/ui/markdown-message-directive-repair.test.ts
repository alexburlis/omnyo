import { describe, expect, it } from "vitest";
import { repairMessageDirectiveLines } from "./markdown-message-directive-repair.js";

const NAMES = new Set(["status-table", "callout"]);

describe("repairMessageDirectiveLines", () => {
  it.each([
    [
      "backslash-escaped quotes",
      '::status-table{labels="A|B" values="\\"Can\'t do that\\"|Done" tones="positive|positive"}',
      '::status-table{labels="A|B" values="&quot;Can\'t do that&quot;|Done" tones="positive|positive"}',
    ],
    [
      "bare quotes inside a value",
      '::status-table{labels="A|B" values="Ok|"Opened" after 1.5 s" tones="positive|warning"}',
      '::status-table{labels="A|B" values="Ok|&quot;Opened&quot; after 1.5 s" tones="positive|warning"}',
    ],
    [
      "a stray closing brace between attributes",
      '::status-table{labels="A|B"}" values="Ok|Ok"}',
      '::status-table{labels="A|B" values="Ok|Ok"}',
    ],
    [
      "a missing closing quote on the last value",
      '::status-table{labels="A" values="Ok" tones="positive}',
      '::status-table{labels="A" values="Ok" tones="positive"}',
    ],
    [
      "an escaped apostrophe in a single-quoted value",
      "::callout{text='It\\'s ready'}",
      "::callout{text='It&#39;s ready'}",
    ],
  ])("repairs %s", (_name, input, expected) => {
    expect(repairMessageDirectiveLines(`Intro\n${input}\n\nOutro`, NAMES)).toBe(
      `Intro\n${expected}\n\nOutro`,
    );
  });

  it.each([
    ["a valid directive", '::status-table{labels="A|B" values="x|y" hidden}'],
    ["curly quotes", '::callout{text="Say “hi” and it\'s done"}'],
    ["an unregistered directive", '::inline-vis{file="a \\"b\\".html"}'],
    ["a streaming directive", '::callout{text="Say \\"hi'],
    ["indented code", '    ::callout{text="Say \\"hi\\""}'],
  ])("leaves %s unchanged", (_name, input) => {
    expect(repairMessageDirectiveLines(input, NAMES)).toBe(input);
  });

  it("leaves directives inside fenced code unchanged", () => {
    const input = ["```md", '::callout{text="Say \\"hi\\""}', "```"].join("\n");

    expect(repairMessageDirectiveLines(input, NAMES)).toBe(input);
  });
});
