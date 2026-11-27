import type { DirectiveAttributes } from "./block-fields";

const rowFields = new Set(["labels", "values", "details", "refs", "states"]);

const headingFields = new Set(["title", "label", "text"]);

const presentationFields = new Set(["tone", "tones", "kind", "columns"]);

function pieces(value: string | undefined, separator: string): string[] {
  return value === undefined ? [] : value.split(separator).map((piece) => piece.trim());
}

function rowsOf(attributes: DirectiveAttributes): string[][] {
  const labels = pieces(attributes.labels, "|");
  const pipeValues = pieces(attributes.values, "|");

  const values =
    pipeValues.length === 1 && labels.length > 1 ? pieces(attributes.values, ",") : pipeValues;

  const columns = [labels, values, pieces(attributes.details, "|"), pieces(attributes.refs, "|")];
  const count = Math.max(...columns.map((column) => column.length));

  return Array.from({ length: count }, (_, row) =>
    columns.flatMap((column) => (column[row] ? [column[row]] : [])),
  ).filter((cells) => cells.length > 0);
}

export function ReadableFallback({
  attributes,
  source,
  reason,
}: {
  attributes: DirectiveAttributes | null;
  source: string;
  reason: string;
}) {
  const fields = attributes ?? {};
  const heading = (fields.title ?? fields.label)?.trim();
  const text = fields.text?.trim();
  const rows = rowsOf(fields);

  const rest = Object.entries(fields).flatMap(([name, value]) =>
    rowFields.has(name) ||
    headingFields.has(name) ||
    presentationFields.has(name) ||
    value.trim().length === 0
      ? []
      : [value.trim()],
  );

  if (!heading && !text && rows.length === 0 && rest.length === 0) {
    return source.trim() ? (
      <div className="omnyo-inline-fallback" data-reason={reason}>
        <p>{source.trim()}</p>
      </div>
    ) : null;
  }

  return (
    <div className="omnyo-inline-fallback" data-reason={reason}>
      {heading ? <strong>{heading}</strong> : null}
      {text ? <p>{text}</p> : null}
      {rows.length > 0 ? (
        <ul>
          {rows.map(([first, ...others], index) => (
            <li key={index}>
              <strong>{first}</strong>
              {others.length > 0 ? ` — ${others.join(" — ")}` : null}
            </li>
          ))}
        </ul>
      ) : null}
      {rest.length > 0 ? <p className="omnyo-inline-fallback__meta">{rest.join(" · ")}</p> : null}
    </div>
  );
}
