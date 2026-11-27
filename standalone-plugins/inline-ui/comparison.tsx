import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk/app";
import { ReadableFallback } from "./invalid";
import { containsMarkup } from "./record-fields";
import "./comparison.css";

interface ComparisonSeries {
  name: string;
  values: number[];
  valueTexts: string[];
}

interface ComparisonData {
  label: string;
  labels: string[];
  unit: string;
  note: string;
  series: ComparisonSeries[];
}

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function validText(value: string, limit: number): boolean {
  return (
    value.length <= limit &&
    !containsMarkup(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);

      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

function text(value: string, limit: number, required = false): string | null {
  if (!validText(value, limit)) return null;
  const trimmed = value.trim();

  return required && trimmed.length === 0 ? null : trimmed;
}

function values(source: string, count: number): string[] | null {
  const parts = source.split(source.includes(",") ? "," : "|");

  if (parts.length !== count) return null;
  const valueTexts = parts.map((part) => part.trim());

  if (
    parts.some((part) => part.length > 100) ||
    valueTexts.some((value) => {
      const number = Number(value);

      return (
        !decimal.test(value) ||
        !Number.isFinite(number) ||
        Math.abs(number) > 1e12 ||
        (number === 0 && /[1-9]/u.test(value.split(/[eE]/u)[0]))
      );
    })
  ) {
    return null;
  }

  return valueTexts;
}

type ComparisonParseResult = { ok: true; data: ComparisonData } | { ok: false; reason: string };

function failed(reason: string): ComparisonParseResult {
  return { ok: false, reason };
}

const valuesReason = "needs one finite decimal per category, within ±1e12";

function parseComparison(
  attributes: PluginMessageDirectiveProps["attributes"],
): ComparisonParseResult {
  if (attributes.labels === undefined || attributes.values === undefined) {
    return failed("it needs labels and values");
  }

  const labelParts = attributes.labels.split("|");

  if (labelParts.length > 30) return failed("a comparison has at most 30 categories");
  const labels: string[] = [];

  for (const [index, part] of labelParts.entries()) {
    const label = text(part, 120, true);

    if (label === null) {
      return failed(`category ${index + 1} must be filled, at most 120 characters`);
    }

    labels.push(label);
  }

  const label = text(attributes.label ?? "Comparison", 120, true);
  const unit = text(attributes.unit ?? "", 40);
  const note = text(attributes.note ?? "", 400);
  const firstName = text(attributes.series ?? "Values", 40, true);
  const firstValues = values(attributes.values, labels.length);

  if (label === null) return failed("the label must be filled, at most 120 characters");

  if (unit === null) return failed("the unit must be at most 40 characters");

  if (note === null) return failed("the note must be at most 400 characters");

  if (firstName === null) return failed("the series name must be filled, at most 40 characters");

  if (!firstValues) return failed(`values ${valuesReason}`);

  const series: ComparisonSeries[] = [
    { name: firstName, values: firstValues.map(Number), valueTexts: firstValues },
  ];

  if (attributes.values2 !== undefined) {
    const namedSecond = text(attributes.series2 ?? "Second", 40, true);
    const secondName = namedSecond === firstName ? `${namedSecond} (2)` : namedSecond;
    const secondValues = values(attributes.values2, labels.length);

    if (secondName === null) return failed("series2 must be filled, at most 40 characters");

    if (!secondValues) return failed(`values2 ${valuesReason}`);
    series.push({
      name: secondName,
      values: secondValues.map(Number),
      valueTexts: secondValues,
    });
  }

  return { ok: true, data: { label, labels, unit, note, series } };
}

function ComparisonView({ data }: { data: ComparisonData }) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [tabBar, setTabBar] = useState(0);
  const count = data.labels.length * data.series.length;
  const tabIndex = Math.min(tabBar, count - 1);
  const allValues = data.series.flatMap((series) => series.values);
  const minimum = Math.min(0, ...allValues);
  const maximum = Math.max(0, ...allValues);
  const span = maximum - minimum;
  const zero = span === 0 ? 0 : (-minimum / span) * 100;
  const paired = data.series.length === 2;

  function moveFocus(event: KeyboardEvent<HTMLDivElement>, index: number) {
    let next: number;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(count - 1, index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(0, index - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    setTabBar(next);
    barRefs.current[next]?.focus();
  }

  return (
    <section className="omnyo-inline-comparison" aria-label={data.label}>
      <h3 className="omnyo-inline-comparison__heading">{data.label}</h3>
      {paired ? (
        <div className="omnyo-inline-comparison__legend" aria-label="Series">
          {data.series.map((series, index) => (
            <span className="omnyo-inline-comparison__legend-item" key={index}>
              <span
                className="omnyo-inline-comparison__swatch"
                data-series={index}
                aria-hidden="true"
              />
              {series.name}
            </span>
          ))}
        </div>
      ) : null}
      <p className="omnyo-inline-comparison__instructions">
        Use arrow keys, Home, or End to inspect bars. The data table follows the comparison.
      </p>
      <div className="omnyo-inline-comparison__rows">
        {data.labels.map((category, rowIndex) => (
          <div className="omnyo-inline-comparison__row" key={rowIndex}>
            <h4 className="omnyo-inline-comparison__category">{category}</h4>
            <div className="omnyo-inline-comparison__entries">
              {data.series.map((series, seriesIndex) => {
                const index = rowIndex * data.series.length + seriesIndex;
                const value = series.values[rowIndex];
                const valueText = series.valueTexts[rowIndex];
                const left = span === 0 ? 0 : ((Math.min(0, value) - minimum) / span) * 100;
                const width = span === 0 ? 0 : (Math.abs(value) / span) * 100;
                const name = `${category}: ${series.name} ${valueText}${data.unit ? ` ${data.unit}` : ""}`;

                return (
                  <div className="omnyo-inline-comparison__entry" key={seriesIndex}>
                    <div className="omnyo-inline-comparison__value-line">
                      {paired ? (
                        <span className="omnyo-inline-comparison__series-name">{series.name}</span>
                      ) : null}
                      <strong className="omnyo-inline-comparison__value">
                        <span className="omnyo-inline-comparison__number">{valueText}</span>
                        {data.unit ? (
                          <span className="omnyo-inline-comparison__unit">{data.unit}</span>
                        ) : null}
                      </strong>
                    </div>
                    <div className="omnyo-inline-comparison__track">
                      <span
                        className="omnyo-inline-comparison__zero"
                        style={{ left: `${zero}%` }}
                        aria-hidden="true"
                      />
                      <div
                        className="omnyo-inline-comparison__bar"
                        data-series={seriesIndex}
                        ref={(element) => {
                          barRefs.current[index] = element;
                        }}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        role="img"
                        aria-label={name}
                        tabIndex={tabIndex === index ? 0 : -1}
                        onKeyDown={(event) => moveFocus(event, index)}
                        onFocus={() => setTabBar(index)}
                        onClick={(event) => event.currentTarget.focus()}
                      >
                        <span className="omnyo-inline-comparison__fill" aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {data.note ? <p className="omnyo-inline-comparison__note">{data.note}</p> : null}
      <details className="omnyo-inline-comparison__details">
        <summary>Data · {data.labels.length} categories</summary>
        <table className="omnyo-inline-comparison__table">
          <caption className="omnyo-inline-comparison__instructions">
            {data.label} values{data.unit ? ` in ${data.unit}` : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              {data.series.map((series, index) => (
                <th scope="col" key={index}>
                  {series.name}
                  {data.unit ? ` (${data.unit})` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.labels.map((category, index) => (
              <tr key={index}>
                <th scope="row">{category}</th>
                {data.series.map((series, seriesIndex) => (
                  <td key={seriesIndex}>{series.valueTexts[index]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** Input that cannot be drawn as bars stays readable as text. */
export function ComparisonBars({ attributes, source }: PluginMessageDirectiveProps) {
  const parsed = useMemo(() => parseComparison(attributes), [attributes]);

  if (!parsed.ok) {
    return <ReadableFallback attributes={attributes} reason={parsed.reason} source={source} />;
  }

  return <ComparisonView data={parsed.data} />;
}
