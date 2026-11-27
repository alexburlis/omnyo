export type DirectiveAttributes = Readonly<Record<string, string>>;

export const toneNames = ["neutral", "info", "positive", "warning", "negative", "muted"] as const;

export type Tone = (typeof toneNames)[number];

const toneAliases: ReadonlyMap<string, Tone> = new Map([
  ["success", "positive"],
  ["ok", "positive"],
  ["pass", "positive"],
  ["passed", "positive"],
  ["done", "positive"],
  ["good", "positive"],
  ["warn", "warning"],
  ["caution", "warning"],
  ["error", "negative"],
  ["danger", "negative"],
  ["critical", "negative"],
  ["fail", "negative"],
  ["failed", "negative"],
  ["bad", "negative"],
  ["note", "info"],
  ["default", "neutral"],
  ["secondary", "muted"],
]);

export function readTone(value: string | undefined, fallback: Tone = "neutral"): Tone {
  const name = value?.trim().toLowerCase() ?? "";

  if (!name) return fallback;

  return toneNames.find((tone) => tone === name) ?? toneAliases.get(name) ?? "neutral";
}

export function calloutProblem(attributes: DirectiveAttributes): string | null {
  const text = attributes.text?.trim() ?? "";

  if (!text && !attributes.title?.trim()) {
    return 'it has no text; write the message in text="…" on the same line, with no body or closing ::';
  }

  if (text.length > 1200) return "the text is longer than 1200 characters";

  if ((attributes.title?.trim().length ?? 0) > 120)
    return "the title is longer than 120 characters";

  return null;
}

export function badgeProblem(attributes: DirectiveAttributes): string | null {
  const text = attributes.text?.trim();

  if (!text) return 'it has no text; write it in text="…"';

  if (text.length > 120) return "the text is longer than 120 characters";

  return null;
}

export function metricRowProblem(attributes: DirectiveAttributes): string | null {
  const labels = attributes.labels?.trim();
  const values = attributes.values?.trim();

  if (!labels || !values) return "metrics need labels and values";

  if (labels.length > 480 || values.length > 320) return "the labels or values are too long";
  const labelList = labels.split("|");
  const valueList = values.split("|");
  const details = attributes.details?.split("|");

  if (labelList.length > 4) return "a metric row has at most four metrics";

  if (valueList.length !== labelList.length) return "each metric needs exactly one value";

  if (labelList.some((value) => !value.trim() || value.length > 120)) {
    return "each label must be filled and at most 120 characters";
  }

  if (valueList.some((value) => !value.trim() || value.length > 80)) {
    return "each value must be filled and at most 80 characters";
  }

  if (details && details.length !== labelList.length) return "each metric needs exactly one detail";

  if (details?.some((value) => value.length > 160)) {
    return "each detail must be at most 160 characters";
  }

  return null;
}

const plainNumber = /^\d+(?:\.\d+)?$/u;

export function progressProblem(attributes: DirectiveAttributes): string | null {
  const label = attributes.label?.trim();
  const rawValue = attributes.value ?? "";
  const rawMax = attributes.max ?? "100";

  if (!label) return "it needs a label";

  if (label.length > 120) return "the label is longer than 120 characters";

  if (!plainNumber.test(rawValue)) return "the value must be a plain number such as 4 or 2.5";

  if (!plainNumber.test(rawMax)) return "max must be a plain number such as 100";
  const value = Number(rawValue);
  const maximum = Number(rawMax);

  if (!Number.isFinite(value) || !Number.isFinite(maximum)) return "the numbers are not finite";

  if (maximum <= 0 || maximum > 1e12) return "max must be above 0 and at most 1e12";

  if (value > maximum) return "the value is larger than max";

  if ((attributes.note?.trim().length ?? 0) > 400) return "the note is longer than 400 characters";

  return null;
}
