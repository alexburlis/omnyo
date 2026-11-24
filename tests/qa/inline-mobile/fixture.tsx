import * as React from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../../../packages/shared-ui/src/components/ui/tooltip";
import { Icon } from "../../../packages/shared-ui/src/components/ui/icon";
import "../../../packages/shared-ui/src/components/ui/icon-extended";
import type {
  ExperimentalFileOpenOptions,
  MarkdownProps,
  PluginSdkApp,
} from "@omnyo/plugin-sdk";
import { collectPluginAppRegistrations } from "../../../packages/plugin-sdk/src/internal/plugin-app-collector";
import { MarkdownPreview } from "../../../apps/app/src/components/ui/markdown-preview";
import { definePluginApp } from "../../../apps/app/src/lib/plugin-app-definition";
import "./fixture.css";

const file = "reports/a-long-folder-name-with-many-segments/mobile-preview.md";

const content = [
  "# Mobile preview",
  "| Account identifier | Current allowance percent | Next reset timestamp | Provider subscription name | Observation timestamp |",
  "| --- | --- | --- | --- | --- |",
  ...Array.from(
    { length: 28 },
    (_, index) =>
      `| Subscription account ${index + 1} | 98 percent available | Tomorrow at 14:30 UTC | Included subscription allowance | 2026-10-13 10:00 UTC |`,
  ),
  ...Array.from(
    { length: 12 },
    (_, index) =>
      `Paragraph ${index + 1}: This is a bounded production Markdown preview with enough content to scroll.`,
  ),
]
  .join("\n\n")
  .replaceAll("|\n\n|", "|\n|");

const html = (height: number) =>
  `<!doctype html><html><body style="margin:0"><div style="height:${height}px;background:var(--background);color:var(--foreground)">HTML height ${height}</div></body></html>`;

const calls: { method: string; value: unknown }[] = [];

const rpc = {
  async call(method: string, input: { file: string }) {
    if (method !== "preparePreview")
      throw new Error(`Unexpected fixture method: ${method}`);

    if (input.file.endsWith(".md")) {
      return {
        kind: "markdown",
        file: input.file,
        source: "workspace",
        target: {
          kind: "workspace",
          environmentId: "env_fixture",
          path: input.file,
        },
        rootPath: "/fixture",
        content,
      };
    }

    const height = input.file === "short.html" ? 120 : 1800;

    return {
      kind: "html",
      file: input.file,
      source: "workspace",
      target: {
        kind: "workspace",
        environmentId: "env_fixture",
        path: input.file,
      },
      url: `/fixture/${input.file}`,
      content: html(height),
      sha256: `fixture-${height}`,
    };
  },
};

const navigate = {
  experimental_openFilePreview(value: ExperimentalFileOpenOptions) {
    calls.push({ method: "open", value });

    return true;
  },
};

const runtime: Partial<PluginSdkApp> = {
  definePluginApp,
  experimental_Icon: Icon,

  useRpc: () => rpc as ReturnType<PluginSdkApp["useRpc"]>,

  experimental_useAppNavigate: () => navigate as ReturnType<PluginSdkApp["experimental_useAppNavigate"]>,
  Markdown: ({ content: text, className }: MarkdownProps) => (
    <MarkdownPreview allowHtml content={text} className={className} />
  ),
};

const host = Object.assign(globalThis, {
  __omnyoPluginRuntime: { react: React, pluginSdkApp: runtime },
  __inlineMobileProof: { calls, ready: false, file },
});

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    async writeText(value: string) {
      calls.push({ method: "copy", value });
    },
  },
});

const definition = (await import("../../../plugins/inline-vis/app")).default;

const registrations = collectPluginAppRegistrations(definition);

const Directive = registrations.messageDirectives[0]!.component;

const Fence = registrations.codeFenceRenderers[0]!.component;

const message = {
  id: "msg_fixture",
  threadId: "thr_fixture",
  turnId: "turn_fixture",
  projectId: "proj_fixture",
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Previews() {
  const [generation, setGeneration] = useState(0);

  return (
    <main>
      <h1>Production inline preview fixture</h1>
      <button type="button" onClick={() => setGeneration(generation + 1)}>
        Remount previews
      </button>
      <div key={generation}>
        <section className="fixture-section" data-testid="markdown">
          <Directive
            attributes={{ file }}
            source={`::inline-vis{file="${file}"}`}
            message={message}
            openWorkspaceFile={null}
          />
        </section>
        <section className="fixture-section" data-testid="tall-html">
          <Directive
            attributes={{ file: "tall.html" }}
            source='::inline-vis{file="tall.html"}'
            message={message}
            openWorkspaceFile={null}
          />
        </section>
        <section className="fixture-section" data-testid="short-html">
          <Directive
            attributes={{ file: "short.html" }}
            source='::inline-vis{file="short.html"}'
            message={message}
            openWorkspaceFile={null}
          />
        </section>
        <section className="fixture-section" data-testid="closed-fence">
          <Fence
            code={html(900)}
            language="inline-vis"
            status="closed"
            index={0}
            message={message}
            Original={() => (
              <pre data-testid="fence-source">Original HTML source</pre>
            )}
          />
        </section>
        <section className="fixture-section" data-testid="streaming-fence">
          <Fence
            code="<div>Streaming"
            language="inline-vis"
            status="streaming"
            index={1}
            message={message}
            Original={() => <pre>Unexpected source</pre>}
          />
        </section>
        <section className="fixture-section" data-testid="unclosed-fence">
          <Fence
            code="<div>Unclosed"
            language="inline-vis"
            status="unclosed"
            index={2}
            message={message}
            Original={() => <pre>Unclosed source retained</pre>}
          />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <TooltipProvider>
        <Previews />
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

host.__inlineMobileProof.ready = true;
