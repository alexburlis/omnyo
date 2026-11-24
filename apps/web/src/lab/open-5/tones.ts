export type Rgb = readonly [number, number, number];

export interface Tones {
  bg: readonly [base: Rgb, stage: Rgb];
  fg: readonly [base: Rgb, stage: Rgb];
}

const PAPER: Rgb = [242, 241, 236];

const INK: Rgb = [12, 12, 13];

export const FIXED_TONES: Tones = { bg: [PAPER, INK], fg: [INK, PAPER] };

export const TONE_PROPERTIES = {
  baseBg: "--tone-base-bg",
  baseFg: "--tone-base-fg",
  stageBg: "--tone-stage-bg",
  stageFg: "--tone-stage-fg",
} as const;

function readRgb(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
  name: string,
): Rgb {
  const raw = style.getPropertyValue(name).trim();
  const channels = raw.split(/\s+/u).map(Number);
  const [r, g, b] = channels;

  if (
    channels.length !== 3 ||
    r === undefined ||
    g === undefined ||
    b === undefined ||
    !channels.every((value) => Number.isFinite(value) && value >= 0)
  ) {
    throw new Error(`${name} must hold three RGB channels, got "${raw}"`);
  }

  return [r, g, b];
}

export const readTones = (
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): Tones => ({
  bg: [
    readRgb(style, TONE_PROPERTIES.baseBg),
    readRgb(style, TONE_PROPERTIES.stageBg),
  ],
  fg: [
    readRgb(style, TONE_PROPERTIES.baseFg),
    readRgb(style, TONE_PROPERTIES.stageFg),
  ],
});

const mix = ([from, to]: readonly [Rgb, Rgb], amount: number): Rgb => {
  const channel = (index: 0 | 1 | 2) =>
    Math.round(from[index] + (to[index] - from[index]) * amount);

  return [channel(0), channel(1), channel(2)];
};

const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

export const toneBg = (tones: Tones, stage: number) =>
  css(mix(tones.bg, stage));

export const toneFg = (tones: Tones, stage: number) =>
  css(mix(tones.fg, stage));

export const toneFgUnit = (
  tones: Tones,
  stage: number,
): [number, number, number] => {
  const [r, g, b] = mix(tones.fg, stage);

  return [r / 255, g / 255, b / 255];
};
