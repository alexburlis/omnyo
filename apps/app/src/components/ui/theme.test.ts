import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION_DURATION_MS, MOTION_EASE } from "@omnyo/shared-ui/motion";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "theme.css"),
  "utf8",
);

function modeBlock(scheme: "light" | "dark", source = css): string {
  const at = source.indexOf(`color-scheme: ${scheme};`);

  if (at === -1) throw new Error(`no ${scheme} block in theme.css`);

  return source.slice(source.lastIndexOf("{", at) + 1, source.indexOf("}", at));
}

function rampSteps(block: string): Map<string, number> {
  const re =
    /--([a-z-]+):\s*color-mix\(in okl(?:ch|ab), var\(--ink\) ([\d.]+)%, (?:var\(--canvas\)|transparent)\);/g;

  const steps = new Map<string, number>();

  for (const match of block.matchAll(re)) {
    steps.set(match[1], Number(match[2]));
  }

  return steps;
}

const REQUIRED_RAMP_TOKENS = [
  "secondary",
  "accent",
  "muted",
  "state-hover",
  "state-active",
  "border",
  "border-hairline",
  "border-seam",
  "input",
  "sidebar",
  "sidebar-accent",
  "sidebar-border",
] as const;

const MODES = ["light", "dark"] as const;

type Mode = (typeof MODES)[number];

const ANCHORS: Record<Mode, { canvas: string; ink: string }> = {
  light: { canvas: "oklch(0.997 0.002 268)", ink: "oklch(0.3211 0.012 268)" },
  dark: { canvas: "oklch(0.178 0.011 268)", ink: "oklch(0.897 0.01 267)" },
};

interface OklchColor {
  lightness: number;
  chroma: number;
  hueDegrees: number;
}

interface LinearRgb {
  blue: number;
  green: number;
  red: number;
}

function variableValue(block: string, token: string): string {
  const re = new RegExp(`--${token}:\\s*([^;]+);`);
  const match = block.match(re);
  const value = match?.[1];

  if (value === undefined) {
    throw new Error(`--${token} not defined`);
  }

  return value.trim();
}

function parseOklch(value: string): OklchColor {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/);
  const lightness = match?.[1];
  const chroma = match?.[2];
  const hueDegrees = match?.[3];

  if (
    lightness === undefined ||
    chroma === undefined ||
    hueDegrees === undefined
  ) {
    throw new Error(`expected oklch() value, got ${value}`);
  }

  return {
    lightness: Number(lightness),
    chroma: Number(chroma),
    hueDegrees: Number(hueDegrees),
  };
}

function oklchToLinearRgb(color: OklchColor): LinearRgb {
  const hueRadians = (color.hueDegrees * Math.PI) / 180;
  const a = color.chroma * Math.cos(hueRadians);
  const b = color.chroma * Math.sin(hueRadians);

  const l = color.lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = color.lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = color.lightness - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  return {
    red: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    green: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    blue: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  };
}

function relativeLuminance(color: OklchColor): number {
  const rgb = oklchToLinearRgb(color);

  return 0.2126 * rgb.red + 0.7152 * rgb.green + 0.0722 * rgb.blue;
}

function contrastRatio(foreground: OklchColor, background: OklchColor): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme.css neutral ramp", () => {
  it("keeps touch sidebar titles stable under hover and open action states", () => {
    const mobileRules = css.slice(css.indexOf("@media (hover: none)"));

    expect(mobileRules).toMatch(
      /\.omnyo-sidebar-hover-actions-row:is\(:hover, :has\(:focus-visible\)\)\s+\.omnyo-sidebar-hover-actions-inset,\s+\.omnyo-sidebar-hover-actions-row:has\(\s+\.omnyo-sidebar-hover-actions\[data-sidebar-hover-actions-open="true"\]\s+\)\s+\.omnyo-sidebar-hover-actions-inset\s*\{\s*padding-right:\s*0;/,
    );
  });

  it("backs selected sticky sidebar rows with the opaque chrome layer", () => {
    const rule = css
      .match(
        /\[data-sidebar-sticky-tier\]\.omnyo-sidebar-selected-row\s*\{([^}]*)\}/s,
      )?.[1]
      .replace(/\s+/g, "");

    expect(rule).toContain(
      "linear-gradient(var(--state-active),var(--state-active))",
    );
    expect(rule).toContain(
      "linear-gradient(var(--material-chrome-solid),var(--material-chrome-solid))",
    );
  });

  it("backs accent-tinted sticky sidebar rows with the opaque chrome layer", () => {
    const rule = css
      .match(
        /\[data-sidebar-sticky-tier\]\.omnyo-sidebar-accent-row:is\([^{]+\)\s*\{([^}]*)\}/s,
      )?.[1]
      .replace(/\s+/g, "");

    expect(rule).toContain(
      "linear-gradient(var(--sidebar-accent),var(--sidebar-accent))",
    );
    expect(rule).toContain(
      "linear-gradient(var(--material-chrome-solid),var(--material-chrome-solid))",
    );
  });

  it("caps the scrollport strip above pinned sidebar rows", () => {
    const rule = css
      .replace(/\s+/g, " ")
      .match(/\[data-sidebar-sticky-stack\]::before \{([^}]*)\}/)?.[1];

    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toContain("background-color: var(--material-chrome-solid)");
    expect(rule).toContain(
      "height: var(--omnyo-sidebar-sticky-stack-padding-top)",
    );
    expect(rule).toContain(
      "margin-top: calc(-1 * var(--omnyo-sidebar-sticky-stack-padding-top))",
    );
  });

  it("keeps the scrollport cap below label controls but above project rows", () => {
    const cap = Number(
      css.match(
        /\[data-sidebar-sticky-stack\]::before\s*\{[^}]*z-index:\s*(\d+)/,
      )?.[1],
    );

    const tier = (name: string) =>
      Number(
        css.match(
          new RegExp(
            `\\[data-sidebar-sticky-tier="${name}"\\]\\s*\\{[^}]*--omnyo-sidebar-sticky-tier-z-index:\\s*(\\d+)`,
          ),
        )?.[1],
      );

    expect(cap).toBeLessThan(tier("label"));
    expect(cap).toBeGreaterThan(tier("project"));
  });

  it("collapses the label slot when a section header is not sticky", () => {
    const compact = css
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")");

    const declarations = (selector: string): string | undefined =>
      compact.match(new RegExp(`${selector} \\{([^}]*)\\}`))?.[1];

    expect(
      declarations(
        '\\[data-sidebar-sticky-stack\\] \\[data-sidebar-sticky-header="false"\\]',
      ),
    ).toContain(
      "--omnyo-sidebar-sticky-project-top: var(--omnyo-sidebar-sticky-stack-padding-top)",
    );
    expect(
      declarations(
        "\\[data-sidebar-sticky-stack\\] \\[data-sidebar-sticky-section\\]",
      ),
    ).toContain(
      "--omnyo-sidebar-sticky-parent-base-top: var(--omnyo-sidebar-sticky-project-top)",
    );
  });

  it("resolves the open-in-split thread tint to an opaque chrome color", () => {
    const rule = css.match(
      /\.omnyo-sidebar-open-in-split-row\s*\{([^}]*)\}/s,
    )?.[1];

    expect(rule).toContain("color-mix(");
    expect(rule).toContain("in oklch");
    expect(rule).toContain("var(--sidebar-accent) 50%");
    expect(rule).toContain("var(--material-chrome-solid)");
    expect(rule).not.toContain("transparent");

    const stickyRule = css.match(
      /\[data-sidebar-sticky-tier\]\.omnyo-sidebar-open-in-split-row\s*\{([^}]*)\}/s,
    )?.[1];

    expect(stickyRule).toContain("background-image: linear-gradient(");
    expect(
      stickyRule?.match(/var\(--omnyo-sidebar-open-in-split-background\)/g),
    ).toHaveLength(2);
  });

  for (const mode of MODES) {
    describe(mode, () => {
      const block = modeBlock(mode);
      const steps = rampSteps(block);

      const step = (token: string): number => {
        const value = steps.get(token);

        if (value === undefined) throw new Error(`--${token} not derived`);

        return value;
      };

      it("defines the canvas and ink anchors", () => {
        expect(variableValue(block, "canvas")).toBe(ANCHORS[mode].canvas);
        expect(variableValue(block, "ink")).toBe(ANCHORS[mode].ink);
      });

      it("derives every neutral-ramp token from the anchors", () => {
        for (const token of REQUIRED_RAMP_TOKENS) {
          expect(
            steps.has(token),
            `--${token} must derive from var(--ink)/var(--canvas), not a literal`,
          ).toBe(true);
        }
      });

      it("uses one seam value for every app-shell boundary", () => {
        expect(block).toMatch(
          /--border-seam-vertical:\s*var\(--border-seam\);/,
        );
      });

      it("keeps card and popover flush with the background", () => {
        expect(steps.has("card")).toBe(false);
        expect(steps.has("popover")).toBe(false);
        expect(block).toMatch(/--card:\s*var\(--canvas\);/);
        expect(block).toMatch(/--popover:\s*var\(--canvas\);/);
      });

      it("orders fills below borders below input", () => {
        for (const fill of ["secondary", "accent", "muted", "state-hover"]) {
          expect(step(fill)).toBeLessThan(step("border"));
        }

        expect(step("border")).toBeLessThanOrEqual(step("input"));
      });

      it("makes the pressed/selected fill stronger than hover", () => {
        expect(step("state-active")).toBeGreaterThan(step("state-hover"));
        expect(step("sidebar-accent")).toBeGreaterThan(step("sidebar"));
      });

      it("keeps the sidebar a quiet chrome lift below the fills", () => {
        expect(step("sidebar")).toBeLessThan(step("secondary"));
      });
    });
  }

  it("defines the same ramp tokens in light and dark", () => {
    const rampTokens = (mode: Mode) =>
      [...rampSteps(modeBlock(mode)).keys()]
        .filter((token) => !token.startsWith("material-"))
        .sort();

    expect(rampTokens("light")).toEqual(rampTokens("dark"));
  });

  it("derives translucent (transparent-mixed) tokens in oklab, not oklch", () => {
    const offenders = [
      ...css.matchAll(/color-mix\(\s*in oklch\b[^;]*?\btransparent\b/g),
    ].map((match) => match[0].replace(/\s+/g, " "));

    expect(offenders).toEqual([]);
  });
});

describe("theme.css Cadence text tokens", () => {
  it("registers Cadence color and type utilities with Tailwind", () => {
    expect(css).toMatch(
      /--color-readback-foreground:\s*var\(--readback-foreground\);/,
    );
    expect(css).toMatch(/--color-timeline-accent:\s*var\(--timeline-accent\);/);
    expect(css).toMatch(
      /--color-destructive-text:\s*var\(--destructive-text\);/,
    );
    expect(css).toMatch(/--text-2xs:\s*0\.625rem;/);
    expect(css).toMatch(/--text-2xs--line-height:\s*0\.875rem;/);
  });

  for (const mode of MODES) {
    it(`keeps ${mode} Cadence text tokens above the AA text floor`, () => {
      const block = modeBlock(mode);
      const canvas = parseOklch(variableValue(block, "canvas"));

      const readbackForeground = parseOklch(
        variableValue(block, "readback-foreground"),
      );

      const timelineAccent = parseOklch(
        variableValue(block, "timeline-accent"),
      );

      const destructiveText = parseOklch(
        variableValue(block, "destructive-text"),
      );

      expect(contrastRatio(readbackForeground, canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(timelineAccent, canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(destructiveText, canvas)).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});

describe("app.css chat reading size", () => {
  it("sets chat prose in the utilities layer so it beats text-sm", () => {
    const appCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../app.css"),
      "utf8",
    );

    const rule = appCss.indexOf(
      "[data-message-column] [data-markdown-preview]",
    );

    expect(rule).toBeGreaterThan(appCss.lastIndexOf("@layer utilities"));
    expect(appCss.lastIndexOf("@layer utilities")).toBeGreaterThan(-1);
  });
});

describe("theme.css body text", () => {
  for (const mode of MODES) {
    it(`keeps ${mode} body text above the AA text floor on the canvas`, () => {
      const tokens = modeTokens(mode);
      const canvas = parseOklch(resolvedValue(tokens, "canvas"));

      for (const token of [
        "foreground",
        "muted-foreground",
        "subtle-foreground",
      ]) {
        expect(
          contrastRatio(parseOklch(resolvedValue(tokens, token)), canvas),
          `--${token}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

const AMBIENT_TOKENS = ["ambient-1", "ambient-2", "ambient-3"] as const;

const MATERIAL_TOKENS = [
  "material-chrome",
  "material-chrome-solid",
  "material-smoke",
  "material-raised",
  "material-line",
  "material-highlight",
  "material-shadow",
] as const;

const MATERIAL_SOURCES = new Set(["canvas", "ink", "shadow-color"]);

const REDUCED_TRANSPARENCY = "@media (prefers-reduced-transparency: reduce) {";

const COLOR_LITERAL = /#[\da-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|color)\(/i;

const MATERIAL_STATES: readonly {
  mode: Mode;
  reducedTransparency: boolean;
  glow: boolean;
}[] = [
  { mode: "light", reducedTransparency: false, glow: false },
  { mode: "light", reducedTransparency: true, glow: false },
  { mode: "dark", reducedTransparency: false, glow: true },
  { mode: "dark", reducedTransparency: true, glow: false },
];

function declarations(body: string): Map<string, string> {
  const source = body.replace(/\/\*[\s\S]*?\*\//g, "");

  return new Map(
    Array.from(source.matchAll(/--([a-z\d-]+):\s*([^;]+);/g), (match) => [
      match[1],
      match[2]
        .replace(/\s+/g, " ")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
        .trim(),
    ]),
  );
}

function modeTokens(mode: Mode): Map<string, string> {
  const light = declarations(modeBlock("light"));

  if (mode === "light") return light;

  return new Map([...light, ...declarations(modeBlock("dark"))]);
}

function reducedTransparencyTokens(mode: Mode): Map<string, string> {
  const at = css.indexOf(REDUCED_TRANSPARENCY);

  if (at === -1) throw new Error("no reduced-transparency block in theme.css");

  const body = css.slice(
    at + REDUCED_TRANSPARENCY.length,
    css.indexOf("\n}\n", at),
  );

  const tokens = modeTokens(mode);

  for (const [, selectors, rule] of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const applies = selectors
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => selector === ":root" || selector === `.${mode}`);

    if (!applies) continue;

    for (const [name, value] of declarations(rule)) tokens.set(name, value);
  }

  return tokens;
}

function tokenValue(
  tokens: ReadonlyMap<string, string>,
  token: string,
): string {
  const value = tokens.get(token);

  if (value === undefined) throw new Error(`--${token} not defined`);

  return value;
}

function resolvedValue(
  tokens: ReadonlyMap<string, string>,
  token: string,
): string {
  const value = tokenValue(tokens, token);
  const reference = value.match(/^var\(--([a-z\d-]+)\)$/)?.[1];

  return reference === undefined ? value : resolvedValue(tokens, reference);
}

function splitArguments(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of input) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  parts.push(current.trim());

  return parts;
}

function alphaOf(value: string, tokens: ReadonlyMap<string, string>): number {
  const reference = value.match(/^var\(--([a-z\d-]+)\)$/)?.[1];

  if (reference !== undefined) {
    return alphaOf(tokenValue(tokens, reference), tokens);
  }

  if (value === "transparent") return 0;

  const mix = value.match(/^color-mix\(in okl(?:ab|ch), (.+)\)$/)?.[1];

  if (mix !== undefined) {
    const [first, second] = splitArguments(mix).map((operand) => {
      const weighted = operand.match(/^(.+?) ([\d.]+)%$/);

      return {
        alpha: alphaOf(weighted?.[1] ?? operand, tokens),
        percentage: weighted === null ? null : Number(weighted[2]),
      };
    });

    if (first === undefined || second === undefined) {
      throw new Error(`expected two color-mix() operands in ${value}`);
    }

    const p1 =
      first.percentage ??
      (second.percentage === null ? 50 : 100 - second.percentage);

    const p2 = second.percentage ?? 100 - p1;

    return (first.alpha * p1 + second.alpha * p2) / Math.max(p1 + p2, 100);
  }

  const color = value.match(
    /^(?:oklch|oklab|rgb|hsl)\([^/()]*(?:\/\s*([\d.]+))?\)$/,
  );

  if (color === null) throw new Error(`cannot read the alpha of ${value}`);

  return color[1] === undefined ? 1 : Number(color[1]);
}

function literalSources(
  tokens: ReadonlyMap<string, string>,
  token: string,
): Set<string> {
  const value = tokenValue(tokens, token);
  const sources = new Set<string>();

  if (COLOR_LITERAL.test(value.replace(/var\(--[a-z\d-]+\)/g, ""))) {
    sources.add(token);
  }

  for (const [, reference] of value.matchAll(/var\(--([a-z\d-]+)\)/g)) {
    for (const source of literalSources(tokens, reference)) {
      sources.add(source);
    }
  }

  return sources;
}

describe("theme.css shell material", () => {
  for (const mode of MODES) {
    it(`defines the ambient and material tokens in the ${mode} block`, () => {
      const block = declarations(modeBlock(mode));

      for (const token of [...AMBIENT_TOKENS, ...MATERIAL_TOKENS]) {
        expect(block.has(token), `--${token}`).toBe(true);
      }
    });
  }

  for (const { mode, reducedTransparency, glow } of MATERIAL_STATES) {
    const state = `${mode}${reducedTransparency ? " with Reduce Transparency" : ""}`;

    const stateTokens = () =>
      reducedTransparency ? reducedTransparencyTokens(mode) : modeTokens(mode);

    const alphaIn = (tokens: ReadonlyMap<string, string>, token: string) =>
      alphaOf(tokenValue(tokens, token), tokens);

    const contract = glow
      ? "lets the ambient glow through translucent chrome and smoke"
      : "keeps the chrome and smoke opaque with no ambient glow";

    it(`${contract} in ${state}`, () => {
      const tokens = stateTokens();

      for (const token of AMBIENT_TOKENS) {
        const alpha = alphaIn(tokens, token);

        if (glow) {
          expect(alpha, `--${token}`).toBeGreaterThan(0);
        } else {
          expect(alpha, `--${token}`).toBe(0);
        }
      }

      for (const token of [
        "material-chrome",
        "material-smoke",
        "material-raised",
      ]) {
        const alpha = alphaIn(tokens, token);

        if (glow) {
          expect(alpha, `--${token}`).toBeGreaterThan(0);
          expect(alpha, `--${token}`).toBeLessThan(1);
        } else {
          expect(alpha, `--${token}`).toBe(1);
        }
      }

      expect(alphaIn(tokens, "material-chrome-solid")).toBe(1);
    });

    it(`derives the ${state} material from --canvas, --ink and --shadow-color`, () => {
      const tokens = stateTokens();

      for (const token of MATERIAL_TOKENS) {
        const foreign = [...literalSources(tokens, token)].filter(
          (source) => !MATERIAL_SOURCES.has(source),
        );

        expect(foreign, `--${token}`).toEqual([]);

        if (alphaIn(tokens, token) < 1) {
          expect(tokenValue(tokens, token), `--${token}`).not.toMatch(
            /in oklch/,
          );
        }
      }
    });
  }

  it("tints the dark glow with chromatic oklch, never a grey literal", () => {
    const block = modeBlock("dark");

    for (const token of AMBIENT_TOKENS) {
      const chroma = variableValue(block, token).match(
        /^oklch\([\d.]+ ([\d.]+) [\d.]+ \/ [\d.]+\)$/,
      )?.[1];

      expect(Number(chroma), `--${token}`).toBeGreaterThan(0);
    }
  });

  it("keeps today's light look: the sidebar, popover and border it replaces", () => {
    const tokens = modeTokens("light");

    expect(resolvedValue(tokens, "material-chrome")).toBe(
      resolvedValue(tokens, "sidebar"),
    );
    expect(resolvedValue(tokens, "material-smoke")).toBe(
      resolvedValue(tokens, "popover"),
    );
    expect(resolvedValue(tokens, "material-line")).toBe(
      resolvedValue(tokens, "border"),
    );
    expect(alphaOf(tokenValue(tokens, "material-highlight"), tokens)).toBe(0);
  });

  it("puts Reduce Transparency after the mode blocks so it wins the cascade", () => {
    const darkBlockEnd = css.indexOf("}", css.indexOf("color-scheme: dark;"));

    expect(css.indexOf(REDUCED_TRANSPARENCY)).toBeGreaterThan(darkBlockEnd);
  });
});

describe("theme.css terminal font token", () => {
  it("provides the existing terminal font stack as the default", () => {
    const fontFamily = variableValue(modeBlock("light"), "font-terminal");

    expect(fontFamily).toContain('"JetBrainsMono Nerd Font Mono"');
    expect(fontFamily).toContain('"Courier New", monospace');
  });
});

describe("theme.css semantic update surfaces", () => {
  it("registers the attention surface utility with Tailwind", () => {
    expect(css).toMatch(
      /--color-surface-attention:\s*var\(--surface-attention\);/,
    );
  });

  for (const mode of MODES) {
    it(`derives the ${mode} attention surface from the semantic color in a hue-safe space`, () => {
      expect(variableValue(modeBlock(mode), "surface-attention")).toMatch(
        /^color-mix\(in oklab, var\(--attention\) [\d.]+%, transparent\)$/,
      );
    });
  }
});

describe("theme.css desktop portal hit testing", () => {
  it("carves portaled overlays out of native window drag regions", () => {
    const rule = css.match(
      /\[data-omnyo-portaled-overlay\]\s*\{([^}]*)\}/,
    )?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/(?:^|\s)app-region:\s*no-drag;/);
    expect(rule).toMatch(/-webkit-app-region:\s*no-drag;/);
  });
});

describe("theme.css resize width registration", () => {
  it("registers --sidebar-width as a non-inherited length", () => {
    const rule = css.match(/@property --sidebar-width\s*\{([^}]*)\}/)?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/syntax:\s*"<length>";/);
    expect(rule).toMatch(/inherits:\s*false;/);
    expect(rule).toMatch(/initial-value:\s*\d+px;/);
  });

  it("registers --secondary-swipe-width as non-inherited, keeping its var() fallback", () => {
    const rule = css.match(
      /@property --secondary-swipe-width\s*\{([^}]*)\}/,
    )?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/syntax:\s*"\*";/);
    expect(rule).toMatch(/inherits:\s*false;/);
    expect(rule).not.toMatch(/initial-value/);
  });
});

describe("theme.css shimmer and scroll-anchor paint scope", () => {
  function ruleBody(selector: string, source = css): string {
    const at = source.indexOf(`${selector} {`);

    if (at === -1) throw new Error(`no ${selector} rule in theme.css`);

    return source.slice(at, source.indexOf("}", at));
  }

  const sweepPng = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "shine-sweep.png"),
  );

  function sweepChunks(png: Buffer): { type: string; data: Buffer }[] {
    const chunks: { type: string; data: Buffer }[] = [];
    let at = 8;

    while (at < png.length) {
      const length = png.readUInt32BE(at);
      chunks.push({
        type: png.toString("ascii", at + 4, at + 8),
        data: png.subarray(at + 8, at + 8 + length),
      });
      at += length + 12;
    }

    return chunks;
  }

  it("promotes shimmering elements to their own layer only while active", () => {
    expect(ruleBody("  .animate-shine-icon")).toMatch(
      /will-change:\s*transform;/,
    );
  });

  it("sweeps with the animated mask image instead of a CSS animation", () => {
    const shared = ruleBody("  .animate-shine-icon");

    expect(css).toMatch(/ {2}\.animate-shine,\n {2}\.animate-shine-icon \{/);
    expect(shared).toMatch(
      /-webkit-mask-image:\s*url\("\.\/shine-sweep\.png"\);/,
    );
    expect(shared).toMatch(
      /(?<!-)mask-image:\s*url\("\.\/shine-sweep\.png"\);/,
    );
    expect(shared).toMatch(/(?<!-)mask-size:\s*100% 100%;/);
    expect(shared).toMatch(/(?<!-)mask-repeat:\s*no-repeat;/);
    expect(shared).not.toMatch(/animation/);
    expect(ruleBody("  .animate-shine")).not.toMatch(/animation|background/);
    expect(css).not.toMatch(/@keyframes shine/);
  });

  it("ships a looping one-second sweep small enough for Vite to inline", () => {
    const chunks = sweepChunks(sweepPng);
    const control = chunks.find((chunk) => chunk.type === "acTL")?.data;
    const frames = chunks.filter((chunk) => chunk.type === "fcTL");

    const seconds = frames.reduce(
      (total, frame) =>
        total + frame.data.readUInt16BE(20) / frame.data.readUInt16BE(22),
      0,
    );

    expect(sweepPng.length).toBeLessThan(4096);
    expect(control?.readUInt32BE(0)).toBe(frames.length);
    expect(control?.readUInt32BE(4)).toBe(0);
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(seconds).toBeCloseTo(1, 5);
  });

  it("drops the mask and releases the layer under inert or aria-hidden hosts", () => {
    const rule = css.match(
      /\[inert\] \.animate-shine,\s*\[inert\] \.animate-shine-icon,\s*\[aria-hidden="true"\] \.animate-shine,\s*\[aria-hidden="true"\] \.animate-shine-icon \{([^}]*)\}/,
    )?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/(?<!-)mask-image:\s*none;/);
    expect(rule).toMatch(/-webkit-mask-image:\s*none;/);
    expect(rule).toMatch(/will-change:\s*auto;/);
  });

  it("drops the sweep under reduced motion", () => {
    const reduced = css.slice(
      css.lastIndexOf(
        "@media (prefers-reduced-motion: reduce)",
        css.indexOf("-webkit-text-fill-color: currentColor;"),
      ),
    );

    const rule = reduced.match(
      /\.animate-shine,\s*\.animate-shine-icon \{([^}]*)\}/,
    )?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/(?<!-)mask-image:\s*none;/);
    expect(rule).toMatch(/-webkit-mask-image:\s*none;/);
  });
});

describe("theme.css motion tokens", () => {
  function braceDepthAt(index: number): number {
    let depth = 0;

    for (const char of css.slice(0, index)) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
    }

    return depth;
  }

  function motionRootBlock(): { at: number; body: string } {
    const marker = css.indexOf("--motion-ease-standard: cubic-bezier(");

    if (marker === -1) throw new Error("no motion token block in theme.css");

    const at = css.lastIndexOf(":root {", marker);

    return { at, body: css.slice(at, css.indexOf("}", marker)) };
  }

  it("keeps the JavaScript duration constants equal to the CSS tokens", () => {
    const { body } = motionRootBlock();

    for (const [name, ms] of Object.entries(MOTION_DURATION_MS)) {
      expect(body).toMatch(
        new RegExp(`--motion-duration-${name}:\\s*${ms}ms;`),
      );
    }
  });

  it("defines every JavaScript easing constant as a CSS curve", () => {
    const { body } = motionRootBlock();

    for (const value of Object.values(MOTION_EASE)) {
      const token = /^var\((--motion-ease-[a-z-]+)\)$/.exec(value)?.[1];

      expect(token).toBeDefined();
      expect(body).toMatch(new RegExp(`${token}:\\s*(cubic-bezier|linear)\\(`));
    }
  });

  function curveStops(body: string, name: string): number[] {
    const curve = new RegExp(
      `--motion-ease-${name}:\\s*linear\\(([^)]*)\\)`,
    ).exec(body)?.[1];

    expect(curve).toBeDefined();

    return (curve ?? "")
      .split(",")
      .map((stop) => Number.parseFloat(stop.trim()));
  }

  it("settles travel and layout on the smooth spring without overshoot", () => {
    const stops = curveStops(motionRootBlock().body, "smooth");

    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);

    for (let index = 1; index < stops.length; index += 1) {
      expect(stops[index]).toBeGreaterThanOrEqual(stops[index - 1] ?? 0);
      expect(stops[index]).toBeLessThanOrEqual(1);
    }
  });

  it("limits the snappy spring to a barely visible overshoot", () => {
    const stops = curveStops(motionRootBlock().body, "snappy");

    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);
    expect(Math.max(...stops)).toBeGreaterThan(1);
    expect(Math.max(...stops)).toBeLessThanOrEqual(1.01);
  });

  it("keeps the retired curve names resolving for separately built plugins", () => {
    const { body } = motionRootBlock();

    expect(body).toMatch(/--motion-ease-panel:\s*var\(--motion-ease-smooth\);/);
    expect(body).toMatch(
      /--motion-ease-spring:\s*var\(--motion-ease-snappy\);/,
    );
  });

  it("settles small controls without overshoot under reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--motion-ease-snappy:\s*var\(--motion-ease-smooth\);/,
    );
  });

  it("drives disclosures through app-owned keyframes that crossfade under reduced motion", () => {
    for (const name of [
      "accordion-down",
      "accordion-up",
      "collapsible-down",
      "collapsible-up",
    ]) {
      expect(css).toMatch(new RegExp(`--animate-${name}:\\s*omnyo-${name}\\b`));

      const reducedAt = css.indexOf(
        "@media (prefers-reduced-motion: reduce) {\n  :root {",
      );

      const reducedBlock = css.slice(
        reducedAt,
        css.indexOf("\n}\n", reducedAt),
      );

      const keyframes = new RegExp(`@keyframes omnyo-${name} \\{([^@]*)`).exec(
        reducedBlock,
      )?.[1];

      expect(keyframes).toBeDefined();
      expect(keyframes).not.toMatch(/height/);
    }
  });

  it("re-asserts Tailwind motion defaults outside cascade layers so plugin sheets cannot override them", () => {
    const { at, body } = motionRootBlock();

    expect(braceDepthAt(at)).toBe(0);
    expect(body).toMatch(
      /--default-transition-timing-function:\s*var\(--motion-ease-standard\);/,
    );
    expect(body).toMatch(
      /--default-transition-duration:\s*var\(--motion-duration-fast\);/,
    );

    for (const curve of ["in", "out", "in-out"]) {
      expect(body).toMatch(
        new RegExp(`--ease-${curve}:\\s*var\\(--motion-ease-${curve}\\);`),
      );
    }
  });

  it("drives enter and exit animations through app-owned keyframes", () => {
    expect(css).toMatch(/--animate-in:\s*omnyo-motion-enter\b/);
    expect(css).toMatch(/--animate-out:\s*omnyo-motion-exit\b/);
  });

  it("reduces enter and exit animations to a crossfade under reduced motion", () => {
    const full = css.indexOf("@keyframes omnyo-motion-enter {");

    const reduced = css.indexOf(
      "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --motion-ease-snappy",
    );

    expect(full).toBeGreaterThan(-1);
    expect(reduced).toBeGreaterThan(full);

    const reducedBlock = css.slice(reduced, css.indexOf("\n}\n", reduced));

    expect(reducedBlock).toMatch(/@keyframes omnyo-motion-exit/);
    expect(reducedBlock).not.toMatch(/transform/);
  });
});
