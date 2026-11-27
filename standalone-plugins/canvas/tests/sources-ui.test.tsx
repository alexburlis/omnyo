import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BoundModule } from "../components/bound-module";
import { SourcePanel } from "../components/sources";
import { sourceInputSchema, type Dataset, type SourceState } from "../source-contract";

afterEach(cleanup);

const dataset: Dataset = {
  sourceId: "search",
  columns: [
    { key: "day", label: "Day", type: "string" },
    { key: "clicks", label: "Clicks", type: "number" },
  ],
  rows: [{ day: "2026-10-31", clicks: 245 }],
  revision: 1,
  capturedAt: 100,
  provenance: {
    timezone: "America/Los_Angeles",
    windowLabel: "2026-10-31",
    cohort: "Google clicks, not visitors",
  },
};

const state: SourceState = {
  source: {
    definition: sourceInputSchema.parse({
      id: "search",
      title: "Search",
      provider: "json",
      config: { url: "https://api.example.com", columns: dataset.columns },
    }),
    status: "ready",
    error: null,
    lastAttemptAt: 100,
    lastSuccessAt: 100,
    nextRefreshAt: null,
    failures: 0,
  },
  dataset,
};

it("renders source-bound metrics with their cohort and snapshot time", () => {
  render(
    <BoundModule
      binding={{ sourceId: "search", view: "metric", y: "clicks" }}
      dataset={dataset}
      source={state.source}
    />,
  );
  expect(screen.getByText("245")).toBeTruthy();
  expect(screen.getByText(/Google clicks, not visitors/)).toBeTruthy();
  expect(screen.getByText(/Captured/)).toBeTruthy();
});

it("makes charts available as accessible images and keyboard-operable text tables", () => {
  render(
    <BoundModule
      binding={{ sourceId: "search", view: "bar", x: "day", y: "clicks" }}
      dataset={dataset}
    />,
  );
  expect(screen.getByRole("img", { name: /Clicks by Day/ })).toBeTruthy();
  const summary = screen.getByText("Read values as a table");
  fireEvent.click(summary);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Clicks" })).toBeTruthy();
});

it("renders table ratios as percentages while preserving numeric positions", () => {
  render(
    <BoundModule
      binding={{ sourceId: "search", view: "table" }}
      dataset={{
        ...dataset,
        columns: [
          { key: "page", label: "Page", type: "string" },
          { key: "ctr", label: "Click-through rate", type: "number", format: "percent" },
          { key: "position", label: "Avg. position", type: "number", format: "number" },
        ],
        rows: [{ page: "https://example.com/", ctr: 0.086, position: 8.62 }],
      }}
    />,
  );
  expect(screen.getByRole("columnheader", { name: "Click-through rate" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Avg. position" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "8.6%" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "8.62" })).toBeTruthy();
});

it("fails visibly when a bound column disappears and handles null numeric values", () => {
  const { rerender } = render(
    <BoundModule binding={{ sourceId: "search", view: "bar", y: "removed" }} dataset={dataset} />,
  );

  expect(screen.getByRole("status").textContent).toContain("no longer available");
  rerender(
    <BoundModule
      binding={{ sourceId: "search", view: "line", y: "clicks" }}
      dataset={{ ...dataset, rows: [{ day: "2026-10-31", clicks: null }] }}
    />,
  );
  expect(screen.getByText("No numeric values in this source window.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("labels failed refreshes while retaining last successful numbers", () => {
  render(
    <BoundModule
      binding={{ sourceId: "search", view: "metric", y: "clicks" }}
      dataset={dataset}
      source={{ ...state.source, status: "error", error: "Source returned HTTP 429" }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Last successful data");
  expect(screen.getByText("245")).toBeTruthy();
});

it("saves a PostHog query and exposes source refresh/pause without credential values", async () => {
  const save = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const pause = vi.fn(async () => {});
  render(
    <SourcePanel
      sources={[state]}
      onSave={save}
      onRefresh={refresh}
      onPause={pause}
      onPush={async () => {}}
      onAddModule={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Search.*JSON API/ }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith("search"));
  fireEvent.click(screen.getByRole("button", { name: "Pause polling" }));
  await waitFor(() => expect(pause).toHaveBeenCalledWith("search", true));
  fireEvent.click(screen.getByRole("button", { name: "Add source" }));
  fireEvent.change(screen.getByLabelText("Source type"), { target: { value: "posthog" } });
  fireEvent.change(screen.getByLabelText("HogQL query"), {
    target: { value: "SELECT 1 AS value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "posthog",
        config: { projectId: 1, query: "SELECT 1 AS value" },
      }),
    ),
  );
  expect(screen.queryByLabelText(/token/i)).toBeNull();
});

it("seeds a new source draft with an unused id and refuses to overwrite another source", async () => {
  const save = vi.fn(async () => {});

  const existing: SourceState = {
    ...state,
    source: {
      ...state.source,
      definition: { ...state.source.definition, id: "new-source", title: "Existing" },
    },
  };

  render(
    <SourcePanel
      sources={[existing]}
      onSave={save}
      onRefresh={async () => {}}
      onPause={async () => {}}
      onPush={async () => {}}
      onAddModule={async () => {}}
    />,
  );

  const definition = screen.getByLabelText<HTMLTextAreaElement>("Source definition");
  expect(JSON.parse(definition.value)).toMatchObject({ id: "new-source-2" });

  fireEvent.change(definition, {
    target: { value: definition.value.replace('"new-source-2"', '"new-source"') },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already exists");
  expect(save).not.toHaveBeenCalled();
});
