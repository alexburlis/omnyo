import { useEffect, useState, type ReactNode } from "react";
import { PluginSlotMount } from "../src/components/plugin/PluginSlotMount";
import weeklyContentFeed from "../../../plugins/automations/workflow-fixtures/weekly-content-feed.json";
import type { Copy } from "../../../plugins/automations/workflow-panel-shared";
import {
  AutomationAuthoring,
  WorkflowCopies,
  WorkflowIntake,
} from "../../../plugins/automations/workflow-panel";
import type { AutomationResponse } from "../../../plugins/automations/src/rpc-types";
import { workflowPackageSchema } from "../../../plugins/automations/src/workflow-package";

export default { title: "Automations/Workflow setup" };

const pkg = workflowPackageSchema.parse(weeklyContentFeed);

const digest = (seed: string) => seed.repeat(64).slice(0, 64);

const facts = [
  "1. Members log each seed packet with its variety, source garden and harvest year.",
  "2. Swap organizers publish a date, a place and a seed wish list in one page.",
  "3. Attendees reserve up to five packets before the swap opens.",
  "4. Germination notes from past growers appear beside each variety.",
  "5. Organizers print table labels with QR codes that link to the variety notes.",
  "6. A reminder goes out to every attendee two days before the swap.",
  "7. After the swap, members mark which packets they planted and share results.",
].join("\n");

const bindings = {
  hostId: "host_mac",
  providerId: "codex" as const,
  model: "gpt-5.4",
  inputs: {
    startup: "Mosslight Workshop",
    audience: "Organizers of neighborhood seed swaps",
    "product-facts": facts,
    "reference-urls": "",
    inventory: "",
    "example-content": "",
    terminology: "seed swap",
    exclusions: "Pricing or claims about real customers",
    "output-language": "English",
    "output-format": "Markdown",
    timezone: "America/Toronto",
    "delivery-weekday": 4,
  },
};

const baseCopy: Copy = {
  importId: "imp_weekly",
  projectId: "proj_mosslight",
  graphId: "graph_weekly",
  graphVersion: 1,
  automationId: null,
  package: pkg,
  packageDigest: digest("a1"),
  executionDigest: digest("b2"),
  bindingRevision: 0,
  bindings: null,
  confirmation: null,
};

function exampleFor(copy: Copy) {
  return [
    String(copy.bindings?.inputs.startup ?? "Your first week"),
    "Draft focus from your saved brief",
    ...String(copy.bindings?.inputs["product-facts"] ?? "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 7),
    "Run once to generate the articles and their review records.",
  ].join("\n");
}

function useMockRpc(initial: Copy, listed: "copy" | "none" = "copy") {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let copy = initial;
    const originalFetch = globalThis.fetch;

    const handlers: Record<
      string,
      (input: Record<string, unknown>) => unknown
    > = {
      workflow_options: (input) => ({
        projects: [{ id: "proj_mosslight", name: "Mosslight" }],
        hosts: [{ id: "host_mac", name: "MacBook Pro" }],
        models: input.hostId
          ? [
              {
                id: "codex:gpt-5.4",
                model: "gpt-5.4",
                providerId: "codex",
                name: "Codex · GPT-5.4",
              },
            ]
          : [],
      }),
      workflow_list: () => (listed === "none" ? [] : [copy]),
      workflow_bind: (input) => {
        copy = {
          ...copy,
          bindings: input.bindings as Copy["bindings"],
          bindingRevision: copy.bindingRevision + 1,
          confirmation: null,
        };

        return copy;
      },
      workflow_preview: () => ({ copy, example: exampleFor(copy) }),
      workflow_confirm: () => {
        copy = { ...copy, confirmation: digest("c3") };

        return copy;
      },
      workflow_inspect: () => ({
        reviewId: "rev_template",
        package: pkg,
        packageDigest: digest("a1"),
        executionDigest: digest("b2"),
        capabilities: ["model-text", "write-run-artifacts"],
        source: "template",
      }),
      automations_runs: () => ({ runs: [], hasMore: false, nextCursor: null }),
    };

    globalThis.fetch = async (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;

      const match = /\/api\/v1\/plugins\/automations\/rpc\/([a-z_]+)$/.exec(
        url,
      );

      const handler = match ? handlers[match[1]] : undefined;

      if (!handler) return originalFetch(request, init);
      const input = JSON.parse(String(init?.body ?? "null")) ?? {};

      return new Response(
        JSON.stringify({ ok: true, result: handler(input) }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    };

    setReady(true);

    return () => {
      globalThis.fetch = originalFetch;
    };
  }, [initial, listed]);

  return ready;
}

function Frame({
  copy,
  listed,
  children,
}: {
  copy: Copy;
  listed?: "copy" | "none";
  children: ReactNode;
}) {
  const ready = useMockRpc(copy, listed);

  return (
    <div className="mx-auto box-border w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
      {ready ? (
        <PluginSlotMount
          pluginId="automations"
          slotKind="navPanel"
          slotId="automations"
        >
          {children}
        </PluginSlotMount>
      ) : null}
    </div>
  );
}

const briefCopy = baseCopy;

const savedCopy: Copy = { ...baseCopy, bindings, bindingRevision: 1 };

const confirmedCopy: Copy = { ...savedCopy, confirmation: digest("c3") };

export function Brief() {
  return (
    <Frame copy={briefCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
    </Frame>
  );
}

export function SavedBrief() {
  return (
    <Frame copy={savedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
    </Frame>
  );
}

function ClickWhenReady({ label }: { label: string }) {
  useEffect(() => {
    const timer = setInterval(() => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === label,
      );

      if (button) {
        clearInterval(timer);
        button.click();
      }
    }, 100);

    return () => clearInterval(timer);
  }, [label]);

  return null;
}

export function WeekPreview() {
  return (
    <Frame copy={savedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
      <ClickWhenReady label="Preview" />
    </Frame>
  );
}

export function BriefOptionsOpen() {
  return (
    <Frame copy={savedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
      <ClickWhenReady label="Edit brief" />
    </Frame>
  );
}

export function Confirmed() {
  return (
    <Frame copy={confirmedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
    </Frame>
  );
}

export function CopyList() {
  return (
    <Frame copy={savedCopy}>
      <WorkflowCopies projectId="proj_mosslight" />
    </Frame>
  );
}

export function Import() {
  return (
    <Frame copy={briefCopy}>
      <WorkflowIntake />
    </Frame>
  );
}

export function ImportReview() {
  return (
    <Frame copy={briefCopy}>
      <WorkflowIntake />
      <ClickWhenReady label="Review Weekly Content Feed" />
    </Frame>
  );
}

export function RunsTab() {
  return (
    <Frame copy={confirmedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
      <ClickWhenReady label="Runs" />
    </Frame>
  );
}

export function RunsTabBeforeConfirming() {
  return (
    <Frame copy={savedCopy}>
      <WorkflowCopies projectId="proj_mosslight" importId="imp_weekly" />
      <ClickWhenReady label="Runs" />
    </Frame>
  );
}

export function EmptyCopyList() {
  return (
    <Frame copy={savedCopy} listed="none">
      <WorkflowCopies projectId="proj_mosslight" />
    </Frame>
  );
}

const footerAutomation: AutomationResponse = {
  id: "auto_digest",
  projectId: "proj_mosslight",
  name: "Morning digest",
  enabled: true,
  trigger: {
    triggerType: "schedule",
    cron: "0 9 * * 1-5",
    timezone: "America/Toronto",
  },
  execution: {
    mode: "agent",
    prompt: "Summarize yesterday's commits and open pull requests.",
    providerId: "claude-code",
    model: "claude-fable-5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    environment: { type: "host", workspace: { type: "personal" } },
  },
  origin: "human",
  createdByThreadId: null,
  nextRunAt: Date.UTC(2026, 10, 23, 14),
  lastRunAt: Date.UTC(2026, 10, 22, 14),
  runCount: 12,
  lastRunStatus: "succeeded",
  lastRunThreadId: null,
  lastError: null,
  createdAt: Date.UTC(2026, 9, 22, 14),
  updatedAt: Date.UTC(2026, 10, 22, 14),
};

export function AutomationEdit() {
  return (
    <Frame copy={briefCopy}>
      <AutomationAuthoring automation={footerAutomation} />
    </Frame>
  );
}
