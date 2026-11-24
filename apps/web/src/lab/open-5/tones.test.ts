import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TONE_PROPERTIES, readTones, toneBg, toneFg } from "./tones";

const css = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

function declaredTones(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);

  if (start < 0) throw new Error(`${selector} is not declared`);
  const block = source.slice(start, source.indexOf("}", start));
  const values = new Map<string, string>();

  for (const name of Object.values(TONE_PROPERTIES)) {
    const match = new RegExp(`${name}:\\s*([^;]+);`, "u").exec(block);

    if (match?.[1]) values.set(name, match[1]);
  }

  return { getPropertyValue: (name: string) => values.get(name) ?? "" };
}

describe("readTones", () => {
  it("parses the light and dark tones the homepage declares", () => {
    const light = readTones(declaredTones(css("./styles.css"), ".lab-open-5"));

    const dark = readTones(
      declaredTones(
        css("../combined-a-v2/styles.css"),
        ".dark .lab-open-5.lab-combined-kinetic.lab-combined-a-v2",
      ),
    );

    expect(toneBg(light, 0)).toBe("rgb(242 241 236)");
    expect(toneBg(light, 1)).toBe("rgb(12 12 13)");
    expect(toneFg(light, 1)).toBe("rgb(242 241 236)");
    expect(toneBg(dark, 0)).toBe("rgb(19 19 18)");
    expect(toneBg(dark, 1)).toBe("rgb(6 6 7)");
    expect(toneFg(dark, 0.5)).toBe("rgb(240 239 233)");
  });

  it("names the property that does not hold three channels", () => {
    const style = {
      getPropertyValue: (name: string) =>
        name === TONE_PROPERTIES.stageFg ? "white" : "1 2 3",
    };

    expect(() => readTones(style)).toThrow(/--tone-stage-fg/u);
  });
});
