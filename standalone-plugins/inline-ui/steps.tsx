import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk/app";
import { ReadableFallback } from "./invalid";
import { containsMarkup } from "./record-fields";
import "./steps.css";

const controlCharacters = /\p{Cc}/u;

function plainText(value: string, maximum: number): boolean {
  return value.length <= maximum && !controlCharacters.test(value) && !containsMarkup(value);
}

function entriesProblem(
  name: string,
  values: string[] | undefined,
  count: number,
  maximum: number,
): string | null {
  if (values === undefined) return null;

  if (values.length > count) return `there are more ${name}s than steps`;

  return values.every((value) => plainText(value, maximum))
    ? null
    : `each ${name} must be at most ${maximum} characters without markup`;
}

function stepLabels(attributes: PluginMessageDirectiveProps["attributes"]): string[] | undefined {
  return (attributes.labels ?? attributes.items ?? attributes.steps)?.split("|");
}

function stepsProblem(attributes: PluginMessageDirectiveProps["attributes"]): string | null {
  const label = attributes.label ?? "Steps";
  const labels = stepLabels(attributes);

  if (!label.trim() || !plainText(label, 300)) {
    return "the label must be filled, at most 300 characters and free of markup";
  }

  if (!labels) return "it needs labels";

  if (labels.length > 40) return "a step list has at most 40 steps";

  if (labels.some((value) => !value.trim() || !plainText(value, 300))) {
    return "each step label must be filled, at most 300 characters and free of markup";
  }

  const entries =
    entriesProblem("detail", attributes.details?.split("|"), labels.length, 1200) ??
    entriesProblem("ref", attributes.refs?.split("|"), labels.length, 500) ??
    entriesProblem("state", attributes.states?.split("|"), labels.length, 40);

  if (entries) return entries;

  if (attributes.asof !== undefined && !plainText(attributes.asof, 120)) {
    return "asof must be at most 120 characters without markup";
  }

  if (attributes.note !== undefined && !plainText(attributes.note, 400)) {
    return "the note must be at most 400 characters without markup";
  }

  return null;
}

export function OrderedSteps(props: PluginMessageDirectiveProps) {
  const { attributes } = props;
  const label = attributes.label ?? "Steps";
  const labels = stepLabels(attributes);
  const details = attributes.details?.split("|");
  const states = attributes.states?.split("|").map((state) => state.trim().toLowerCase());
  const refs = attributes.refs?.split("|");
  const asof = attributes.asof;
  const note = attributes.note;
  const problem = stepsProblem(attributes);

  if (problem !== null || !labels) {
    return (
      <ReadableFallback
        attributes={attributes}
        reason={problem ?? "it needs labels"}
        source={props.source}
      />
    );
  }

  return (
    <section className="omnyo-inline-steps" aria-label={label.trim()}>
      <div className="omnyo-inline-steps__header">
        <strong className="omnyo-inline-steps__title">{label.trim()}</strong>
        {asof?.trim() ? <span className="omnyo-inline-steps__asof">{asof.trim()}</span> : null}
      </div>
      <ol className="omnyo-inline-steps__list" role="list">
        {labels.map((itemLabel, index) => (
          <li className="omnyo-inline-steps__item" data-state={states?.[index]} key={index}>
            <span className="omnyo-inline-steps__marker" aria-hidden="true">
              {index + 1}
            </span>
            <div className="omnyo-inline-steps__body">
              <div className="omnyo-inline-steps__heading">
                <strong className="omnyo-inline-steps__label">{itemLabel.trim()}</strong>
                {states?.[index] ? (
                  <span className="omnyo-inline-steps__state">{states[index]}</span>
                ) : null}
              </div>
              {details?.[index]?.trim() ? (
                <div className="omnyo-inline-steps__detail">{details[index].trim()}</div>
              ) : null}
              {refs?.[index]?.trim() ? (
                <div className="omnyo-inline-steps__ref">{refs[index].trim()}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {note?.trim() ? <div className="omnyo-inline-steps__note">{note.trim()}</div> : null}
    </section>
  );
}
