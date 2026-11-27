import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk/app";
import {
  badgeProblem,
  calloutProblem,
  metricRowProblem,
  progressProblem,
  readTone,
  type Tone,
} from "./block-fields";
import { ReadableFallback } from "./invalid";

function CalloutGlyph({ tone }: { tone: Tone }) {
  return (
    <svg
      className="omnyo-inline-callout__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      {tone === "warning" || tone === "negative" ? (
        <path d="M12 8v4M12 16h.01" />
      ) : tone === "positive" ? (
        <path d="m9 12 2 2 4-4" />
      ) : (
        <path d="M12 16v-4M12 8h.01" />
      )}
    </svg>
  );
}

export function MetricRow(props: PluginMessageDirectiveProps) {
  const problem = metricRowProblem(props.attributes);
  const labels = props.attributes.labels?.trim().split("|");
  const values = props.attributes.values?.trim().split("|");
  const details = props.attributes.details?.split("|");

  if (problem !== null || !labels || !values) {
    return (
      <ReadableFallback
        attributes={props.attributes}
        reason={problem ?? "metrics need labels and values"}
        source={props.source}
      />
    );
  }

  return (
    <div className="omnyo-inline-metrics" aria-label="Key metrics">
      {labels.map((label, index) => (
        <div className="omnyo-inline-metric" key={index}>
          <span className="omnyo-inline-metric__label">{label}</span>
          <strong className="omnyo-inline-metric__value">{values[index]}</strong>
          {details?.[index] ? (
            <span className="omnyo-inline-metric__detail">{details[index]}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Callout(props: PluginMessageDirectiveProps) {
  const problem = calloutProblem(props.attributes);
  const content = props.attributes.text?.trim();
  const title = props.attributes.title?.trim();
  const accent = readTone(props.attributes.tone, "info");

  if (problem !== null || (!content && !title)) {
    return (
      <ReadableFallback
        attributes={props.attributes}
        reason={problem ?? "it has no text"}
        source={props.source}
      />
    );
  }

  return (
    <aside className="omnyo-inline-callout" data-tone={accent}>
      <CalloutGlyph tone={accent} />
      <div>
        {title ? <strong>{title}</strong> : null}
        {content ? <p>{content}</p> : null}
      </div>
    </aside>
  );
}

export function InlineBadge(props: PluginMessageDirectiveProps) {
  const problem = badgeProblem(props.attributes);
  const content = props.attributes.text?.trim();
  const accent = readTone(props.attributes.tone, "info");

  if (problem !== null || !content) {
    return (
      <ReadableFallback
        attributes={props.attributes}
        reason={problem ?? "it has no text"}
        source={props.source}
      />
    );
  }

  return (
    <span className="omnyo-inline-badge" data-tone={accent}>
      <span aria-hidden="true" />
      {content}
    </span>
  );
}

export function Progress(props: PluginMessageDirectiveProps) {
  const problem = progressProblem(props.attributes);
  const label = props.attributes.label?.trim();
  const rawValue = props.attributes.value ?? "";
  const rawMax = props.attributes.max ?? "100";
  const value = Number(rawValue);
  const maximum = Number(rawMax);
  const note = props.attributes.note?.trim();

  if (problem !== null || !label) {
    return (
      <ReadableFallback
        attributes={props.attributes}
        reason={problem ?? "it needs a label"}
        source={props.source}
      />
    );
  }

  return (
    <div className="omnyo-inline-progress">
      <div className="omnyo-inline-progress__heading">
        <strong>{label}</strong>
        <span>
          {rawValue} / {rawMax}
        </span>
      </div>
      <div
        className="omnyo-inline-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuemax={maximum}
      >
        <span style={{ width: `${(value / maximum) * 100}%` }} />
      </div>
      {note ? <small>{note}</small> : null}
    </div>
  );
}
