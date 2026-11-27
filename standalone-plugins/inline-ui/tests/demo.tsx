import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ExperimentalProviderModelPickerProps,
  PluginMessageDirectiveProps,
} from "@omnyo/plugin-sdk/app";
import { Callout, InlineBadge, MetricRow, Progress } from "../blocks";
import { MiniChart } from "../chart";
import { ComparisonBars } from "../comparison";
import { FileCard, StatusTable } from "../records";
import { OrderedSteps } from "../steps";
import "../app.css";
import "./fixture.css";
import {
  executeSchema,
  planRunEventSchema,
  type ExecutePlan,
  type PlanReference,
} from "../plan-contract";
import type { z } from "zod";

function FixtureMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div data-testid="omnyo-markdown" className={className}>
      {content}
    </div>
  );
}

const planCalls: ExecutePlan[] = [];

const planNavigation: string[] = [];

const planRuns = new Set<string>();

const removedFiles = new Set<string>();

const missingFilePreviews: string[] = [];

const fileChecks: { hostId: string; paths: string[] }[] = [];

const fileExists = (path: string) => !path.includes("/absent/") && !removedFiles.has(path);

const previewCalls: string[] = [];

type PlanRunEvent = z.infer<typeof planRunEventSchema>;

const realtimeListeners = new Set<(channel: string, payload: PlanRunEvent) => void>();

function useFixtureRealtime(channel: string, handler: (payload: PlanRunEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (published: string, payload: PlanRunEvent) => {
      if (published === channel) latest.current(payload);
    };

    realtimeListeners.add(listener);

    return () => {
      realtimeListeners.delete(listener);
    };
  }, [channel]);
}

function SharedPlanCards(props: PluginMessageDirectiveProps) {
  return (
    <>
      <FileCard {...props} />
      <FileCard {...props} />
    </>
  );
}

function FixtureModelPicker({ value, onChange, disabled }: ExperimentalProviderModelPickerProps) {
  return (
    <button
      aria-label="Execution model"
      disabled={disabled}
      onClick={() =>
        onChange({
          providerId: "other-provider",
          model: "other-model",
          reasoningLevel: "high",
          serviceTier: "default",
        })
      }
    >
      {value.model} · {value.reasoningLevel}
    </button>
  );
}

const fixtureSdk = {
  plugins: {
    callRpc: async <T,>({
      method,
      input,
      outputSchema,
    }: {
      method: string;
      input: PlanReference | ExecutePlan;
      outputSchema: z.ZodType<T>;
    }) => {
      if (input.href.includes("plan-unavailable")) throw new Error("Pursue is unavailable.");

      if (method === "pursue_plan_preview" && !fileExists(input.href)) {
        missingFilePreviews.push(input.href);

        throw Object.assign(new Error(`HTTP 500: HTTP 404: Path does not exist: ${input.href}`), {
          status: 500,
        });
      }

      const started = {
        kind: "started",
        threadId: "fixture-execution",
        selection: {
          providerId: "other-provider",
          model: "other-model",
          reasoningLevel: "high",
          serviceTier: "default",
        },
      };

      const pending = {
        kind: "pending",
        message: "Execution start is unconfirmed. Check the existing request.",
      };

      if (method === "pursue_plan_preview") previewCalls.push(input.href);

      if (
        method === "pursue_plan_preview" &&
        (input.href.includes("plan-owned-shared") || input.href.includes("plan-focus"))
      )
        await new Promise((resolve) => setTimeout(resolve, 400));

      if (method === "pursue_plan_preview")
        return outputSchema.parse(
          input.href.includes("/fixture/plan-")
            ? {
                kind: "plan",
                title: "Example execution plan",
                path: input.href,
                sha256: "b".repeat(64),
                state: input.href.includes("plan-complete")
                  ? "  CoMpLeTe  "
                  : "implementation-ready",
                execution: input.href.includes("plan-complete-pending")
                  ? { kind: "blocked", message: pending.message }
                  : input.href.includes("plan-complete")
                    ? { kind: "complete" }
                    : input.href.includes("plan-blocked")
                      ? { kind: "blocked", message: "The recorded approval is required." }
                      : input.href.includes("plan-no-work")
                        ? { kind: "no-work", message: "No remaining progress items." }
                        : input.href.includes("plan-owned") || planRuns.has(input.href)
                          ? { kind: "running", threadId: started.threadId }
                          : input.href.includes("plan-executing")
                            ? { kind: "in-progress", message: "Execution owner is not linked." }
                            : { kind: "actionable" },
                environmentId: "fixture-environment",
                selection: {
                  providerId: "codex",
                  model: input.href.includes("plan-missing-default")
                    ? "missing-model"
                    : "current-model",
                  reasoningLevel: "ultra",
                  serviceTier: "default",
                },
                selectionIssue: input.href.includes("plan-missing-default")
                  ? "The saved default model is unavailable. Choose another model."
                  : null,
                run: input.href.includes("plan-complete-pending")
                  ? pending
                  : input.href.includes("plan-complete-open") ||
                      input.href.includes("plan-owned") ||
                      planRuns.has(input.href)
                    ? started
                    : null,
              }
            : { kind: "not-plan" },
        );

      if (method !== "pursue_plan_execute") throw new Error("Unexpected plan RPC");
      const execution = executeSchema.parse(input);
      planCalls.push(execution);
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (input.href.includes("plan-changed"))
        throw new Error("The plan changed. Refresh the card before executing.");
      planRuns.add(input.href);

      return outputSchema.parse(
        input.href.includes("plan-pending")
          ? pending
          : { ...started, selection: execution.selection },
      );
    },
  },
  threads: {
    get: async ({ threadId }: { threadId: string }) => {
      if (threadId !== "fixture-thread") throw new Error("Wrong message thread");

      return { environmentId: "fixture-environment" };
    },
  },
  environments: {
    get: async ({ environmentId }: { environmentId: string }) => {
      if (environmentId !== "fixture-environment") throw new Error("Wrong environment");

      return { hostId: "fixture-machine", path: "/fixture/workspace" };
    },
  },
  hosts: {
    pathsExist: async ({ hostId, paths }: { hostId: string; paths: string[] }) => {
      fileChecks.push({ hostId, paths });

      return { existence: Object.fromEntries(paths.map((path) => [path, fileExists(path)])) };
    },
  },
};

Object.assign(globalThis, {
  inlineUiPlanCalls: planCalls,
  inlineUiPlanNavigation: planNavigation,
  inlineUiMissingFilePreviews: missingFilePreviews,
  inlineUiFileChecks: fileChecks,
  inlineUiRemoveFile: (path: string) => removedFiles.add(path),
  inlineUiPreviewCalls: previewCalls,
  inlineUiEmitRealtime: (channel: string, payload: PlanRunEvent) => {
    for (const listener of realtimeListeners) listener(channel, planRunEventSchema.parse(payload));
  },
  __omnyoPluginRuntime: {
    react: React,
    pluginSdkApp: {
      Markdown: FixtureMarkdown,
      useSdk: () => fixtureSdk,
      useRealtime: useFixtureRealtime,
      experimental_useAppNavigate: () => ({
        toThread: (threadId: string) => planNavigation.push(threadId),
      }),
      experimental_ProviderModelPicker: FixtureModelPicker,
      experimental_FileLink: ({
        target,
        children,
        className,
      }: {
        target: unknown;
        children: React.ReactNode;
        className?: string;
      }) => (
        <a className={className} data-testid="omnyo-file-link" data-target={JSON.stringify(target)}>
          {children}
        </a>
      ),
    },
  },
});

const statusAttributes = {
  label: "Example changes",
  columns: "Drop|New behavior",
  labels: "Example junk item|Example useful item|Example rare affix",
  values: "Hidden|Kept|Highlighted",
  tones: "negative|positive|info",
  details: "Common and magic examples||",
  note: "Example rows for layout verification",
};

const fileAttributes = {
  title: "Example filter download",
  href: "/fixture/storage/example filter.txt",
  meta: "12 rules · Example season",
  kind: "download",
};

const metricAttributes = {
  labels: "Accounts|Weekly visitors|Google clicks",
  values: "46|339|274",
  details: "Oct 11|Oct 4–10 · +8%|Oct 2–8 · +24.5%",
};

const chartAttributes = {
  values: "274,281,288,303,310,326,339",
  labels: "Sun|Mon|Tue|Wed|Thu|Fri|Sat",
  label: "Example series",
  unit: "visitors",
  note: "Seven example points for layout verification",
  tone: "positive",
};

const comparisonAttributes = {
  labels: "Public documentation coverage|Local browser verification|Production installation proof",
  values: "8.00,4.50,2.25",
  values2: "4.00,2.25,1.125",
  series: "Example A",
  series2: "Example B",
  label: "Example category comparison",
  unit: "items",
  note: "Invented values; common scale for layout verification",
};

const stepAttributes = {
  labels: "Inspect evidence|Apply scoped repair|Verify the result",
  details: "Read the selected inputs||Record browser proof",
  states: "done|running|pending",
  label: "Example verification sequence",
  asof: "Example only · Oct 11, 2026",
  refs: "Fixture source A|Fixture source B|Fixture proof",
  note: "Example states for layout verification",
};

const attack = '<img src=x onerror="window.inlineUiPayloadExecuted=true">';

const cases = {
  "file-plan-owned": {
    component: FileCard,
    attributes: { title: "Plan with a running owner", href: "/fixture/plan-owned.md" },
  },
  "file-plan-focus": {
    component: FileCard,
    attributes: { title: "Plan clicked from another window", href: "/fixture/plan-focus.md" },
  },
  "file-plan-shared": {
    component: SharedPlanCards,
    attributes: { title: "Plan shown twice", href: "/fixture/plan-owned-shared.md" },
  },
  "file-plan-executing": {
    component: FileCard,
    attributes: { title: "Manual execution in progress", href: "/fixture/plan-executing.md" },
  },
  "file-plan-blocked": {
    component: FileCard,
    attributes: { title: "Plan awaiting required approval", href: "/fixture/plan-blocked.md" },
  },
  "file-plan-no-work": {
    component: FileCard,
    attributes: { title: "Plan with no remaining steps", href: "/fixture/plan-no-work.md" },
  },
  "file-plan-missing-default": {
    component: FileCard,
    attributes: { title: "Missing default example", href: "/fixture/plan-missing-default.md" },
  },
  "file-plan-ready": {
    component: FileCard,
    attributes: {
      title: "Example execution plan",
      href: "/fixture/plan-ready.md",
      meta: "Example only · Plan execution controls",
    },
  },
  "file-plan-complete": {
    component: FileCard,
    attributes: {
      title: "Completed comparison plan",
      href: "/fixture/plan-complete.md",
      meta: "Measured results retained",
    },
  },
  "file-plan-complete-open": {
    component: FileCard,
    attributes: { title: "Completed plan with run", href: "/fixture/plan-complete-open.md" },
  },
  "file-plan-complete-pending": {
    component: FileCard,
    attributes: { title: "Completed plan awaiting run", href: "/fixture/plan-complete-pending.md" },
  },
  "file-plan-changed": {
    component: FileCard,
    attributes: { title: "Changed example plan", href: "/fixture/plan-changed.md" },
  },
  "file-plan-pending": {
    component: FileCard,
    attributes: { title: "Pending example plan", href: "/fixture/plan-pending.md" },
  },
  "file-plan-unavailable": {
    component: FileCard,
    attributes: { title: "Unavailable example plan", href: "/fixture/plan-unavailable.md" },
  },
  "file-absent": {
    component: FileCard,
    attributes: {
      title: "Motion spec",
      href: "/fixture/absent/DESIGN.md",
      meta: "Curves, timings and motion roles",
    },
  },
  "file-absent-relative": {
    component: FileCard,
    attributes: { title: "Relative notes", href: "./absent/notes.txt", meta: "Example notes" },
  },
  "file-plan-removed": {
    component: FileCard,
    attributes: { title: "Plan removed after rendering", href: "/fixture/plan-removed.md" },
  },
  "comparison-single": {
    component: ComparisonBars,
    attributes: {
      labels: "Third category|First category|Second category",
      values: "8.00,4.00,2.00",
      unit: "points",
      label: "Example single series",
    },
  },
  "comparison-paired": { component: ComparisonBars, attributes: comparisonAttributes },
  "comparison-one": {
    component: ComparisonBars,
    attributes: { labels: "Only category", values: "1.2500" },
  },
  "comparison-twelve": {
    component: ComparisonBars,
    attributes: {
      labels: Array.from({ length: 12 }, (_, index) => `Full category name ${index + 1}`).join("|"),
      values: Array.from({ length: 12 }, (_, index) => String(index + 1)).join(","),
    },
  },
  "comparison-zero": {
    component: ComparisonBars,
    attributes: { labels: "First|Second|Third", values: "0,0.00,0" },
  },
  "comparison-negative": {
    component: ComparisonBars,
    attributes: { labels: "First|Second|Third", values: "-6.00,-3.00,0" },
  },
  "comparison-mixed": {
    component: ComparisonBars,
    attributes: {
      labels: "First|Second|Third",
      values: "-3.00,0,6.00",
      values2: "6.00,-1.50,3.00",
      series: "Example A",
      series2: "Example B",
    },
  },
  "comparison-tiny": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "5e-324,1e-323" },
  },
  "comparison-missing": { component: ComparisonBars, attributes: { values: "1,2" } },
  "comparison-empty-label": {
    component: ComparisonBars,
    attributes: { labels: "First||Third", values: "1,2,3" },
  },
  "comparison-mismatch": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2,3" },
  },
  "comparison-malformed": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,nope" },
  },
  "comparison-overflow": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,1000000000001" },
  },
  "comparison-underflow": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1e-400,2e-400" },
  },
  "comparison-unknown": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", maximum: "3" },
  },
  "comparison-oversize": {
    component: ComparisonBars,
    attributes: {
      labels: Array.from({ length: 13 }, (_, index) => `Category ${index + 1}`).join("|"),
      values: Array.from({ length: 13 }, (_, index) => String(index + 1)).join(","),
    },
  },
  "comparison-text-oversize": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", note: "x".repeat(10000) },
  },
  "comparison-markup": {
    component: ComparisonBars,
    attributes: { labels: `First|${attack}`, values: "1,2" },
  },
  "comparison-control": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", unit: "items\u0000" },
  },
  "comparison-pair-mismatch": {
    component: ComparisonBars,
    attributes: {
      labels: "First|Second",
      values: "1,2",
      values2: "3",
      series: "Example A",
      series2: "Example B",
    },
  },
  "comparison-pair-unnamed": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", values2: "3,4", series2: "Example B" },
  },
  "comparison-pair-second-unnamed": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", values2: "3,4", series: "Example A" },
  },
  "comparison-pair-duplicate": {
    component: ComparisonBars,
    attributes: {
      labels: "First|Second",
      values: "1,2",
      values2: "3,4",
      series: "Same",
      series2: "Same",
    },
  },
  "comparison-pair-orphan": {
    component: ComparisonBars,
    attributes: { labels: "First|Second", values: "1,2", series2: "Example B" },
  },
  "steps-neutral": {
    component: OrderedSteps,
    attributes: {
      labels: "Third action|First action|Second action",
      label: "Example neutral sequence",
    },
  },
  "steps-detail": {
    component: OrderedSteps,
    attributes: {
      ...stepAttributes,
      refs: "@thread:thr_example#msg=42|_literal_ `reference`|Fixture proof",
    },
  },
  "steps-all-states": {
    component: OrderedSteps,
    attributes: {
      labels:
        "Pending example|Queued example|Running example|Done example|Waiting example|Blocked example|Failed example|Unknown example",
      states: "pending|queued|running|done|waiting|blocked|failed|unknown",
    },
  },
  "steps-detail-long": {
    component: OrderedSteps,
    attributes: {
      labels: "Measure the release|Publish it",
      details: `${"Run the checks once on the exact candidate and keep the receipt beside it. ".repeat(5).trim()}|`,
    },
  },
  "steps-detail-oversize": {
    component: OrderedSteps,
    attributes: { labels: "Measure the release", details: "x".repeat(501) },
  },
  "steps-one": { component: OrderedSteps, attributes: { labels: "Only action" } },
  "steps-twelve": {
    component: OrderedSteps,
    attributes: {
      labels: Array.from({ length: 12 }, (_, index) => `Full step label ${index + 1}`).join("|"),
    },
  },
  "steps-missing": { component: OrderedSteps, attributes: { label: "No steps" } },
  "steps-empty-label": { component: OrderedSteps, attributes: { labels: "First||Third" } },
  "steps-state-mismatch": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", states: "done" },
  },
  "steps-bad-state": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", states: "done|complete" },
  },
  "steps-detail-mismatch": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", details: "Only one detail" },
  },
  "steps-ref-mismatch": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", refs: "Only one reference" },
  },
  "steps-unknown": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", percent: "50" },
  },
  "steps-oversize": {
    component: OrderedSteps,
    attributes: { labels: Array.from({ length: 13 }, (_, index) => `Step ${index + 1}`).join("|") },
  },
  "steps-text-oversize": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", asof: "x".repeat(10000) },
  },
  "steps-markup": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", details: `Safe|${attack}` },
  },
  "steps-control": {
    component: OrderedSteps,
    attributes: { labels: "First|Second", refs: "Safe|reference\u0000" },
  },
  "status-tones": {
    component: StatusTable,
    attributes: {
      labels: "Neutral row|Positive row|Warning row|Negative row|Info row|Muted row",
      values: "Visible|Passed|Needs approval|Failed|Changed|Skipped",
      tones: "neutral|positive|warning|negative|info|muted",
    },
  },
  "status-long": {
    component: StatusTable,
    attributes: {
      labels: "Short row|Long row",
      values: `Needs approval|${"The command completed, and this explanation preserves the observed behavior and its verification limits. ".repeat(4).trim()}`,
    },
  },
  "status-plain": {
    component: StatusTable,
    attributes: { labels: "Only row", values: "Plain value" },
  },
  "status-twenty": {
    component: StatusTable,
    attributes: {
      labels: Array.from({ length: 20 }, (_, index) => `Full row label ${index + 1}`).join("|"),
      values: Array.from({ length: 20 }, (_, index) => `Value ${index + 1}`).join("|"),
    },
  },
  "status-opportunity-mismatch": {
    component: StatusTable,
    attributes: {
      columns: "Opportunity|Value",
      labels:
        "Cache npm downloads for clean consumer installs|Concrete gap; current cache covers pnpm only|Profile slow release checks and setup|Find avoidable work in the roughly 10-minute sweep",
      values: "Best first candidate|Second priority",
      tones: "info|info",
    },
  },
  "status-opportunities": {
    component: StatusTable,
    attributes: {
      columns: "Opportunity|Value",
      labels:
        "Cache npm downloads for clean consumer installs|Profile slow release checks and setup",
      values: "Best first candidate|Second priority",
      tones: "info|info",
      details:
        "Concrete gap; current cache covers pnpm only|Find avoidable work in the roughly 10-minute sweep",
    },
  },
  "status-missing": { component: StatusTable, attributes: { labels: "First|Second" } },
  "status-mismatch": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: "Only one" },
  },
  "status-empty-value": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: "One|" },
  },
  "status-bad-tone": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: "One|Two", tones: "positive|danger" },
  },
  "status-tone-mismatch": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: "One|Two", tones: "positive" },
  },
  "status-columns": {
    component: StatusTable,
    attributes: { labels: "First", values: "One", columns: "A|B|C|D" },
  },
  "status-detail-column": {
    component: StatusTable,
    attributes: {
      label: "What the GlassScene shader does",
      columns: "Part|Physical?|Detail",
      labels: "Bending at the glass surfaces|Viewing angle|Text dimming",
      values: "Yes|No|Deliberately not",
      tones: "positive|warning|neutral",
      details:
        "Snell's law at the curved top, through the slab, at the flat underside and across an air gap|You look straight down from infinitely far away|",
    },
  },
  "status-row-order": {
    component: StatusTable,
    attributes: {
      label: "Example release readiness",
      columns: "Check|Result|Detail",
      labels: "Core main|Contains the fix|Plugins main|Contains the fix|Release lane|Empty",
      values: "Contains the fix|Contains the fix|Empty",
      tones: "positive|positive|muted",
      details: "Commit on origin/main|Pinned for new installs|Nothing queued",
    },
  },
  "status-detail-mismatch": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: "One|Two", details: "Only one" },
  },
  "status-unknown": {
    component: StatusTable,
    attributes: { labels: "First", values: "One", color: "red" },
  },
  "status-oversize": {
    component: StatusTable,
    attributes: {
      labels: Array.from({ length: 21 }, (_, index) => `Row ${index + 1}`).join("|"),
      values: Array.from({ length: 21 }, (_, index) => `Value ${index + 1}`).join("|"),
    },
  },
  "status-email": {
    component: StatusTable,
    attributes: { labels: "Sender", values: "Acme Operations <hello@example.com>" },
  },
  "steps-email": {
    component: OrderedSteps,
    attributes: { labels: "Send from Acme Operations <hello@example.com>" },
  },
  "comparison-email": {
    component: ComparisonBars,
    attributes: { labels: "Acme Operations <hello@example.com>", values: "1" },
  },
  "status-markup": {
    component: StatusTable,
    attributes: { labels: "First|Second", values: `Safe|${attack}` },
  },
  "status-control": {
    component: StatusTable,
    attributes: { labels: "First", values: "One\u0000" },
  },
  "file-escaped": {
    component: FileCard,
    attributes: {
      title: "Report [draft] *v2*_final (1)",
      href: "/fixture/storage/report (1) [draft].md",
    },
  },
  "file-url": {
    component: FileCard,
    attributes: {
      title: "Example pricing page",
      href: "https://example.com/pricing?a=1&b=2",
      meta: "External reference",
      kind: "link",
    },
  },
  "file-relative": {
    component: FileCard,
    attributes: { title: "Example plan", href: "docs/plans/example.md" },
  },
  "file-path": {
    component: FileCard,
    attributes: {
      title: "COMMANDER-TEST-GUIDE.md",
      meta: "Window notes updated",
      path: "/fixture/storage/COMMANDER-TEST-GUIDE.md",
    },
  },
  "file-path-conflict": {
    component: FileCard,
    attributes: { title: "Conflicting destinations", href: "/fixture/a.md", path: "/fixture/b.md" },
  },
  "file-windows": {
    component: FileCard,
    attributes: { title: "Example log", href: "C:\\fixture\\example.log" },
  },
  "file-missing-href": { component: FileCard, attributes: { title: "No destination" } },
  "file-missing-title": { component: FileCard, attributes: { href: "/fixture/example.md" } },
  "file-javascript": {
    component: FileCard,
    attributes: { title: "Unsafe link", href: "javascript:window.inlineUiPayloadExecuted=true" },
  },
  "file-data": {
    component: FileCard,
    attributes: { title: "Unsafe data", href: "data:text/html,<b>x</b>" },
  },
  "file-angle-href": {
    component: FileCard,
    attributes: { title: "Escape attempt", href: "/fixture/a>b.md" },
  },
  "file-angle-title": {
    component: FileCard,
    attributes: { title: "Title <b>bold</b>", href: "/fixture/example.md" },
  },
  "file-bad-kind": {
    component: FileCard,
    attributes: { title: "Example", href: "/fixture/example.md", kind: "image" },
  },
  "file-unknown": {
    component: FileCard,
    attributes: { title: "Example", href: "/fixture/example.md", target: "_blank" },
  },
  "file-control": {
    component: FileCard,
    attributes: { title: "Example", href: "/fixture/example\u0000.md" },
  },
  flat: {
    component: MiniChart,
    attributes: {
      values: "5,5,5",
      labels: "First|Second|Third",
      label: "Flat series",
      unit: "clicks",
    },
  },
  zero: {
    component: MiniChart,
    attributes: {
      values: "0,0,0",
      labels: "First|Second|Third",
      label: "Zero series",
      unit: "clicks",
    },
  },
  negative: {
    component: MiniChart,
    attributes: {
      values: "-3,-1.25,-4,0",
      labels: "First|Second|Third|Fourth",
      label: "Negative series",
      unit: "points",
      kind: "bar",
    },
  },
  tiny: {
    component: MiniChart,
    attributes: { values: "0.0000001,0.0000002", labels: "First|Second", label: "Tiny series" },
  },
  malformed: {
    component: MiniChart,
    attributes: { values: "1,not-a-number,3", label: "Malformed series" },
  },
  "chart-label-mismatch": {
    component: MiniChart,
    attributes: { values: "1,2,3", labels: "First|Second" },
  },
  "chart-overflow": { component: MiniChart, attributes: { values: "1,Infinity,3" } },
  "chart-underflow": { component: MiniChart, attributes: { values: "1e-400,2e-400" } },
  "chart-oversize": {
    component: MiniChart,
    attributes: { values: Array.from({ length: 81 }, (_, index) => String(index)).join(",") },
  },
  "chart-markup": { component: MiniChart, attributes: { values: "1,2", label: attack } },
  "metric-mismatch": { component: MetricRow, attributes: { labels: "First|Second", values: "42" } },
  "metric-oversize": {
    component: MetricRow,
    attributes: { labels: "One|Two|Three|Four|Five", values: "1|2|3|4|5" },
  },
  "progress-max": {
    component: Progress,
    attributes: { label: "Invalid progress", value: "12", max: "0" },
  },
  "progress-unknown": {
    component: Progress,
    attributes: { label: "Example progress", value: "50", maximum: "200" },
  },
  "progress-number": {
    component: Progress,
    attributes: { label: "Invalid progress", value: "NaN", max: "100" },
  },
  "callout-markup": {
    component: Callout,
    attributes: { title: "Unsafe markup", text: attack, tone: "note" },
  },
  "badge-tone": { component: InlineBadge, attributes: { text: "Invalid badge", tone: "danger" } },
  "status-agent-success": {
    component: StatusTable,
    attributes: {
      labels:
        "Canvas features (sections, views, canvas chats, sidebar row)|iPhone-size layout in iOS Simulator Safari|Smoothness at 60 fps",
      values: "Done and live|Passed|Not measured",
      tones: "success|success|warning",
    },
  },
  "callout-agent-body": {
    component: Callout,
    attributes: { tone: "info", title: "Your 30-second check" },
  },
  "callout-info": {
    component: Callout,
    attributes: {
      tone: "info",
      title: "Your 30-second check",
      text: "Press Cmd+Shift+P, choose Open project canvas, then pan and pinch for about 20 seconds.",
    },
  },
  "callout-negative": {
    component: Callout,
    attributes: { tone: "negative", text: "The release check failed." },
  },
  "badge-success": { component: InlineBadge, attributes: { text: "Verified", tone: "success" } },
};

function directiveNameFor(fixture: string): string {
  if (fixture.startsWith("comparison-")) return "comparison-bars";

  if (fixture.startsWith("steps-")) return "ordered-steps";

  if (fixture.startsWith("status-")) return "status-table";

  if (fixture.startsWith("file-")) return "file-card";

  if (fixture.startsWith("callout-")) return "callout";

  if (fixture.startsWith("badge-")) return "inline-badge";

  return fixture;
}

function sourceFor(name: string, attributes: Record<string, string>): string {
  return `::${name}{${Object.entries(attributes)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ")}}`;
}

function directiveProps(
  name: string,
  attributes: Record<string, string>,
): PluginMessageDirectiveProps {
  return {
    attributes,
    source: sourceFor(name, attributes),
    message: {
      id: "fixture-message",
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      projectId: "fixture-project",
    },
    openWorkspaceFile: null,
  };
}

function Paragraph({ children, marker }: { children: React.ReactNode; marker?: string }) {
  return <p data-paragraph={marker}>{children}</p>;
}

function App() {
  const [fixture, setFixture] = useState("mixed");
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const selected = Object.entries(cases).find(([name]) => name === fixture)?.[1];
  const SelectedComponent = selected?.component;

  return (
    <main>
      <nav aria-label="Browser fixture controls">
        <label>
          Fixture case{" "}
          <select
            aria-label="Fixture case"
            value={fixture}
            onChange={(event) => setFixture(event.target.value)}
          >
            <option value="mixed">Mixed content</option>
            {Object.keys(cases).map((name) => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Theme{" "}
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </nav>
      <article aria-label="Assistant message" data-message-column className="group/message">
        <div data-markdown-preview className="host-markdown">
          <h2>Inline UI preview</h2>
          <Paragraph marker="assistant">
            Example data for layout verification. These sample figures show how metrics sit beside
            prose, tables, and code.
          </Paragraph>
          <div data-native-block="metrics">
            <MetricRow {...directiveProps("metric-row", metricAttributes)} />
          </div>
          <Paragraph>
            The chart uses an invented series to verify layout and exact values. Each example point
            is available by keyboard.
          </Paragraph>
          <div data-native-block="chart">
            <MiniChart {...directiveProps("mini-chart", chartAttributes)} />
          </div>
          <Paragraph>
            The category comparison uses invented values on one common numeric scale.
          </Paragraph>
          <div data-native-block="comparison">
            <ComparisonBars {...directiveProps("comparison-bars", comparisonAttributes)} />
          </div>
          <Paragraph>
            The ordered steps use example states and keep their source references visible.
          </Paragraph>
          <div data-native-block="steps">
            <OrderedSteps {...directiveProps("ordered-steps", stepAttributes)} />
          </div>
          <Paragraph>The status table colors each supplied value by its tone.</Paragraph>
          <div data-native-block="status">
            <StatusTable {...directiveProps("status-table", statusAttributes)} />
          </div>
          <div data-native-block="file">
            <FileCard {...directiveProps("file-card", fileAttributes)} />
          </div>
          <Paragraph>Compact status badge.</Paragraph>
          <div data-native-block="badge">
            <InlineBadge
              {...directiveProps("inline-badge", { text: "Example", tone: "positive" })}
            />
          </div>
          <Paragraph>The next paragraph follows the badge.</Paragraph>
          <div data-native-block="callout">
            <Callout
              {...directiveProps("callout", {
                title: "Layout note",
                text: "Native blocks keep the surrounding prose readable.",
                tone: "note",
              })}
            />
          </div>
          <ul>
            <li>Accounts use a daily total.</li>
            <li>Visitors and clicks retain their own time windows.</li>
          </ul>
          <table>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Window</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Visitors</td>
                <td>Oct 4–10</td>
              </tr>
              <tr>
                <td>Google clicks</td>
                <td>Oct 2–8</td>
              </tr>
            </tbody>
          </table>
          <div data-native-block="progress">
            <Progress
              {...directiveProps("progress", {
                label: "Example coverage",
                value: "68",
                max: "100",
                note: "Example: 68 of 100 items",
              })}
            />
          </div>
          <pre>
            <code>
              {'omnyo inline-ui metrics --labels "Accounts|Weekly visitors"\n  --values "46|339"'}
            </code>
          </pre>
          <Paragraph>End of the inline UI preview.</Paragraph>
          {SelectedComponent && selected ? (
            <section
              data-native-case={fixture}
              data-directive-source={sourceFor(directiveNameFor(fixture), selected.attributes)}
              aria-label="Selected boundary case"
            >
              <h3>Boundary case: {fixture}</h3>
              <SelectedComponent
                key={fixture}
                {...directiveProps(directiveNameFor(fixture), selected.attributes)}
              />
            </section>
          ) : null}
        </div>
      </article>
      <article aria-label="User message" data-message-column>
        <div className="group/message">
          <div data-markdown-preview className="host-markdown">
            <h2>User message</h2>
            <Paragraph marker="user">
              Keep the labels and time windows visible. This user message should retain the host
              Markdown styles.
            </Paragraph>
            <ul>
              <li>Leave user typography unchanged.</li>
            </ul>
            <table>
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Visitors</td>
                  <td>Oct 4–10</td>
                </tr>
              </tbody>
            </table>
            <pre>
              <code>const userMessage = true;</code>
            </pre>
          </div>
        </div>
      </article>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
