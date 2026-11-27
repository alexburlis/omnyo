import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk/app";
import { readTone, type Tone } from "./block-fields";
import { containsMarkup } from "./record-fields";

/**
 * Failure contract: a chart is either fully validated or the renderer shows its
 * content as readable text. Malformed numbers, oversized inputs, mismatched labels
 * and markup cannot become a partial or fabricated series. Unknown fields, kinds and
 * tones are ignored. All visible values retain the supplied decimal text, including
 * tiny values.
 */
export interface MiniChartPoint {
  value: number;
  valueText: string;
  label: string;
}

export interface MiniChartData {
  points: MiniChartPoint[];
  label: string;
  unit: string;
  note: string;
  kind: "line" | "bar";
  tone: Tone;
}

type ChartParseResult = { ok: true; data: MiniChartData } | { ok: false; reason: string };

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function validText(value: string, limit: number): boolean {
  return (
    value.length <= limit &&
    !containsMarkup(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);

      return code < 32 || code === 127;
    })
  );
}

function failed(reason: string): ChartParseResult {
  return { ok: false, reason };
}

export function parseMiniChart(
  attributes: PluginMessageDirectiveProps["attributes"],
): ChartParseResult {
  const valuesSource = attributes.values;

  if (!valuesSource) return failed("it needs comma-separated values");

  if (valuesSource.length > 10_000) return failed("the values are longer than 10000 characters");

  const valueTexts = valuesSource
    .split(valuesSource.includes(",") ? "," : "|")
    .map((value) => value.trim());

  if (valueTexts.length < 2 || valueTexts.length > 80) return failed("a chart has 2 to 80 values");

  const badValue = valueTexts.findIndex(
    (value) =>
      value.length > 100 ||
      !decimal.test(value) ||
      !Number.isFinite(Number(value)) ||
      (Number(value) === 0 && /[1-9]/u.test(value.split(/[eE]/u)[0])) ||
      Math.abs(Number(value)) > 1e12,
  );

  if (badValue !== -1) {
    return failed(`value ${badValue + 1} is not a finite decimal within ±1e12`);
  }

  const kind = attributes.kind?.trim().toLowerCase() === "bar" ? "bar" : "line";
  const tone = readTone(attributes.tone);

  const labelSource = attributes.label ?? "Series";
  const unitSource = attributes.unit ?? "";
  const noteSource = attributes.note ?? "";

  if (!validText(labelSource, 120) || !labelSource.trim()) {
    return failed("the label must be filled, at most 120 characters and free of markup");
  }

  if (!validText(unitSource, 40)) return failed("the unit must be at most 40 characters");

  if (!validText(noteSource, 400)) return failed("the note must be at most 400 characters");

  let labels = valueTexts.map((_, index) => `Point ${index + 1}`);

  if (attributes.labels !== undefined) {
    if (attributes.labels.length > 10_000) return failed("the labels are too long");
    labels = attributes.labels.split("|").map((value) => value.trim());

    if (labels.length !== valueTexts.length) return failed("each value needs exactly one label");

    if (labels.some((value) => value.length === 0 || !validText(value, 120))) {
      return failed("each point label must be filled, at most 120 characters and free of markup");
    }
  }

  return {
    ok: true,
    data: {
      points: valueTexts.map((valueText, index) => ({
        value: Number(valueText),
        valueText,
        label: labels[index],
      })),
      label: labelSource.trim(),
      unit: unitSource.trim(),
      note: noteSource.trim(),
      kind,
      tone,
    },
  };
}
