import { useState } from "react";
import { z } from "zod";
import {
  datasetPushInputSchema,
  sourceInputSchema,
  sourceProviders,
  type DatasetPushInput,
  type NodeBinding,
  type SourceInput,
  type SourceState,
} from "../source-contract";

export interface SourcePanelProps {
  sources: SourceState[];
  busy?: boolean;
  error?: string | null;
  onSave(input: SourceInput): Promise<void>;
  onRefresh(id: string): Promise<void>;
  onPause(id: string, paused: boolean): Promise<void>;
  onPush(input: DatasetPushInput): Promise<void>;
  onAddModule(binding: NodeBinding): Promise<void>;
}

function example(provider: SourceInput["provider"]): SourceInput {
  const base = {
    id: "new-source",
    title: "New data source",
    intervalSeconds: 0,
    paused: false,
    provenance: {},
  };

  switch (provider) {
    case "manual":
      return { ...base, provider, intervalSeconds: 0, config: {} };
    case "json":
      return {
        ...base,
        provider,
        config: {
          url: "https://api.github.com/repos/nodejs/node",
          rowsPath: [],
          columns: [{ key: "stargazers_count", label: "Stars", type: "number" }],
        },
      };
    case "mcp":
      return {
        ...base,
        provider,
        config: {
          url: "https://mcp.example.com/mcp",
          tool: "status",
          arguments: {},
          rowsPath: [],
          columns: [{ key: "status", label: "Status", type: "string" }],
        },
      };
    case "gsc":
      return {
        ...base,
        provider,
        config: {
          siteUrl: "sc-domain:example.com",
          startDate: "2026-10-03",
          endDate: "2026-10-30",
          dimensions: ["date"],
          limit: 100,
        },
      };
    case "posthog":
      return {
        ...base,
        provider,
        provenance: {
          windowLabel: "Last 28 days at refresh",
          timezone: "UTC",
          cohort: "All pageviews",
          unit: "pageviews",
        },
        config: {
          projectId: 1,
          query:
            "SELECT toDate(timestamp) AS day, count() AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 28 DAY GROUP BY day ORDER BY day LIMIT 100",
        },
      };
    case "cloudflare":
      return {
        ...base,
        provider,
        provenance: {
          windowLabel: "Last 24 hours at refresh",
          timezone: "UTC",
          cohort: "Requests at Cloudflare's edge, sampled",
          unit: "requests per hour",
        },
        config: {
          zoneTag: "023e105f4ecef8ad9ca31a8372d0c353",
          query:
            "query($zoneTag: String!, $start: Time!, $end: Time!) { viewer { zones(filter: {zoneTag: $zoneTag}) { series: httpRequestsAdaptiveGroups(limit: 100, orderBy: [datetimeHour_ASC], filter: {datetime_geq: $start, datetime_lt: $end}) { count dimensions { datetimeHour } } } } }",
          rollingHours: 24,
          alignTo: "hour",
          rowsPath: ["series"],
          columns: [
            { key: "hour", label: "Hour", type: "string", path: ["dimensions", "datetimeHour"] },
            { key: "requests", label: "Requests", type: "number", path: ["count"] },
          ],
          credential: "apiToken1",
        },
      };
  }
}

const providerNames: Record<SourceInput["provider"], string> = {
  manual: "Manual dataset",
  json: "JSON API",
  mcp: "MCP tool",
  gsc: "Google Search Console",
  posthog: "PostHog",
  cloudflare: "Cloudflare",
};

function uniqueSourceId(sources: SourceState[]): string {
  let count = 1;
  let id = "new-source";

  while (sources.some((entry) => entry.source.definition.id === id)) {
    count += 1;
    id = `new-source-${count}`;
  }

  return id;
}

function emptyDataset(sourceId: string): string {
  return JSON.stringify(
    { sourceId, columns: [{ key: "value", label: "Value", type: "number" }], rows: [] },
    null,
    2,
  );
}

function parseDraft<Output>(schema: z.ZodType<Output>, text: string, subject: string): Output {
  try {
    return schema.parse(JSON.parse(text));
  } catch (failure) {
    if (failure instanceof SyntaxError) throw new Error(`The ${subject} isn't valid JSON.`);
    throw failure;
  }
}

const errorSchema = z.instanceof(Error).catch(new Error("The source action failed"));

function sourceFailure(failure: Error): string {
  if (failure instanceof z.ZodError) {
    const issue = failure.issues[0];

    if (issue === undefined) return "Check the edited values.";

    return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
  }

  return failure.message;
}

function sourceTime(value: number | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

export function SourcePanel({
  sources,
  busy = false,
  error = null,
  onSave,
  onRefresh,
  onPause,
  onPush,
  onAddModule,
}: SourcePanelProps) {
  const [initialId] = useState(() => uniqueSourceId(sources));

  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({ ...example("manual"), id: initialId }, null, 2),
  );

  const [draft, setDraft] = useState(baseline);
  const [provider, setProvider] = useState<SourceInput["provider"]>("manual");
  const [replacing, setReplacing] = useState<SourceInput["provider"] | null>(null);

  const [query, setQuery] = useState(
    example("posthog").provider === "posthog"
      ? "SELECT count() AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 7 DAY"
      : "",
  );

  const [datasetDraft, setDatasetDraft] = useState(() => emptyDataset(initialId));

  const [localError, setLocalError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const state = sources.find((entry) => entry.source.definition.id === selected);

  const perform = async (action: () => Promise<void>) => {
    setLocalError(null);

    try {
      await action();
    } catch (failure) {
      setLocalError(sourceFailure(errorSchema.parse(failure)));
    }
  };

  function start(nextProvider: SourceInput["provider"]) {
    const definition = example(nextProvider);
    const id = uniqueSourceId(sources);
    const text = JSON.stringify({ ...definition, id }, null, 2);

    setSettingsOpen(true);
    setSelected(null);
    setProvider(nextProvider);
    setReplacing(null);
    setBaseline(text);
    setDraft(text);
    setValues(false);
    setDatasetDraft(emptyDataset(id));

    if (definition.provider === "posthog") setQuery(definition.config.query);
  }

  function choose(id: string) {
    const entry = sources.find((item) => item.source.definition.id === id);

    if (!entry) return;
    const text = JSON.stringify(entry.source.definition, null, 2);

    setSelected(id);
    setSettingsOpen(false);
    setProvider(entry.source.definition.provider);
    setReplacing(null);
    setBaseline(text);
    setDraft(text);

    if (entry.source.definition.provider === "posthog")
      setQuery(entry.source.definition.config.query);
    setDatasetDraft(
      entry.dataset
        ? JSON.stringify(
            {
              sourceId: id,
              columns: entry.dataset.columns,
              rows: entry.dataset.rows,
              provenance: entry.dataset.provenance,
            },
            null,
            2,
          )
        : emptyDataset(id),
    );
    setValues(false);
  }

  async function save() {
    const input = parseDraft(sourceInputSchema, draft, "source definition");

    if (input.id !== selected && sources.some((entry) => entry.source.definition.id === input.id))
      throw new Error(`A source with the id "${input.id}" already exists. Choose another id.`);

    const updated =
      input.provider === "posthog" ? { ...input, config: { ...input.config, query } } : input;

    await onSave(updated);
    setSelected(input.id);
  }

  return (
    <section className="cnv-sources" aria-label="Canvas data sources">
      <div className="cnv-editor-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            start(provider);
          }}
        >
          Add source
        </button>
      </div>
      <p className="cnv-source-meta">Connect a source, then add metrics, charts or tables.</p>
      {error || localError ? (
        <p role="alert" className="cnv-editor-error">
          {localError ?? error}
        </p>
      ) : null}
      <div className="cnv-source-list">
        {sources.map((entry) => (
          <button
            className="cnv-source-item"
            aria-label={`${entry.source.definition.title}, ${providerNames[entry.source.definition.provider]}, ${entry.source.status}`}
            type="button"
            key={entry.source.definition.id}
            aria-pressed={selected === entry.source.definition.id}
            onClick={() => choose(entry.source.definition.id)}
          >
            <strong>{entry.source.definition.title}</strong>
            <span>
              {providerNames[entry.source.definition.provider]} · {entry.source.status}
              {entry.source.definition.paused ? " · paused" : ""}
            </span>
          </button>
        ))}
      </div>
      {state ? (
        <div className="cnv-source-status">
          <p className="cnv-source-meta">
            Last successful refresh: {sourceTime(state.source.lastSuccessAt)}
            <br />
            {state.source.definition.intervalSeconds
              ? `Refresh interval: ${state.source.definition.intervalSeconds} seconds`
              : "Manual refresh"}
            {state.source.definition.paused ? " · paused" : ""}
          </p>
          {state.source.error ? (
            <p role="status" className="cnv-editor-error">
              {state.source.error}
              {state.dataset ? " Last successful data is retained." : ""}
            </p>
          ) : null}
          <div className="cnv-editor-actions">
            <button
              type="button"
              disabled={busy || state.source.definition.provider === "manual"}
              onClick={() => void perform(() => onRefresh(state.source.definition.id))}
            >
              Refresh now
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  onPause(state.source.definition.id, !state.source.definition.paused),
                )
              }
            >
              {state.source.definition.paused ? "Resume polling" : "Pause polling"}
            </button>
            <button type="button" onClick={() => setValues(!values)}>
              {values ? "Hide dataset" : "Inspect dataset"}
            </button>
          </div>
          {values ? (
            <pre className="cnv-source-dataset" tabIndex={0}>
              {JSON.stringify(state.dataset, null, 2)}
            </pre>
          ) : null}
          {state.dataset ? (
            <fieldset className="cnv-field">
              <legend>Add a connected module</legend>
              <div className="cnv-editor-actions">
                {(["metric", "bar", "line", "table"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        onAddModule({
                          sourceId: state.source.definition.id,
                          view,
                          x: state.dataset?.columns.find((column) => column.type === "string")?.key,
                          y: state.dataset?.columns.find((column) => column.type === "number")?.key,
                        }),
                      )
                    }
                  >
                    {
                      { metric: "Metric", bar: "Bar chart", line: "Line chart", table: "Table" }[
                        view
                      ]
                    }
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      ) : null}
      <details
        className="cnv-editor-section"
        open={settingsOpen}
        onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
      >
        <summary>Connection settings</summary>
        <label className="cnv-field">
          Source type
          <select
            aria-label="Source type"
            value={provider}
            onChange={(event) => {
              const next = sourceProviders.find((item) => item === event.target.value) ?? "manual";

              if (draft === baseline) start(next);
              else setReplacing(next);
            }}
          >
            {sourceProviders.map((item) => (
              <option key={item} value={item}>
                {providerNames[item]}
              </option>
            ))}
          </select>
        </label>
        {replacing === null ? null : (
          <div role="alert" className="cnv-editor-notice">
            <p>Replace your edited definition with the {providerNames[replacing]} example?</p>
            <div className="cnv-editor-actions">
              <button type="button" onClick={() => start(replacing)}>
                Replace definition
              </button>
              <button type="button" onClick={() => setReplacing(null)}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        <label className="cnv-field">
          Source definition
          <textarea
            aria-label="Source definition"
            rows={12}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        {provider === "posthog" ? (
          <label className="cnv-field">
            HogQL query
            <textarea
              aria-label="HogQL query"
              rows={6}
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
        <p className="cnv-source-meta">
          Private credentials are managed in Canvas plugin settings.
        </p>
        <button type="button" disabled={busy} onClick={() => void perform(save)}>
          Save source
        </button>
        {provider === "manual" ? (
          <>
            <label className="cnv-field">
              Agent dataset
              <textarea
                aria-label="Agent dataset"
                rows={7}
                spellCheck={false}
                value={datasetDraft}
                onChange={(event) => setDatasetDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !state}
              onClick={() =>
                void perform(() =>
                  onPush(parseDraft(datasetPushInputSchema, datasetDraft, "dataset")),
                )
              }
            >
              Update dataset
            </button>
          </>
        ) : null}
      </details>
    </section>
  );
}
