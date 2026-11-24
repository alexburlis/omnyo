import * as React from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserOmnyoSdk } from "../../../../../packages/sdk/src/browser";
import { Icon } from "../../../../../packages/shared-ui/src/components/ui/icon";
import { PluginImagePreview } from "../../../src/components/plugin/PluginImagePreview";
import { VisualControls } from "../../../../../plugins/browser-automation/visual-controls";
import { rpcContract as browserContract } from "../../../../../plugins/browser-automation/contracts";
import { GlancePage } from "@orca-glance/components/page";
import { ProjectImagePreview } from "@orca-glance/components/project-image";
import { rpcContract as glanceContract } from "@orca-glance/contract";
import "./fixture.css";

function raster(label, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 600;
  const context = canvas.getContext("2d");

  if (context === null) throw new Error("The fixture requires a canvas");
  context.fillStyle = color;
  context.fillRect(0, 0, 900, 600);
  context.fillStyle = "#ffffff";
  context.fillRect(160, 110, 280, 110);
  context.fillStyle = "#182333";
  context.font = "30px sans-serif";
  context.fillText(label, 185, 178);

  return canvas;
}

const capture = raster("Confirm plan", "#d4e4fa");

const resultRaster = raster("Updated layout", "#d9eadc");

const jpeg = capture.toDataURL("image/jpeg", 0.7).split(",")[1];

const pngBlob = await new Promise((resolveBlob) =>
  resultRaster.toBlob(resolveBlob, "image/png"),
);

if (!(pngBlob instanceof Blob))
  throw new Error("The fixture PNG could not be created");

const png = new Uint8Array(await pngBlob.arrayBuffer());

const calls = [];

const urls = { created: [], revoked: [] };

const createUrl = URL.createObjectURL.bind(URL);

const revokeUrl = URL.revokeObjectURL.bind(URL);

URL.createObjectURL = (blob) => {
  const url = createUrl(blob);
  urls.created.push(url);

  return url;
};

URL.revokeObjectURL = (url) => {
  urls.revoked.push(url);
  revokeUrl(url);
};

const state = {
  stale: false,
  observation: 0,
  observationId: crypto.randomUUID(),
  focusedThread: "thr_foreign",
  navigated: [],
  drafts: {},
  markSeen: 0,
};

const draftListeners = new Set();

function composer(threadId) {
  state.drafts[threadId] = {
    text: "Existing draft",
    attachments: [],
    mentions: [],
  };

  return {
    scope: { kind: "thread", threadId },
    replace(change) {
      state.drafts[threadId] = change(state.drafts[threadId]);
      calls.push({ method: "composer.replace", threadId });
    },
    experimental_onSubmittedDraft(listener) {
      draftListeners.add(listener);

      return () => draftListeners.delete(listener);
    },
  };
}

const foreignComposer = composer("thr_foreign");

const originComposer = composer("thr_origin");

const frame = {
  sequence: 1,
  targetId: "target-displayed",
  mimeType: "image/jpeg",
  data: jpeg,
  width: 900,
  height: 600,
  url: "https://fixture.invalid/design",
  title: "Fixture page",
};

const element = {
  id: "element-confirm",
  selector: "#confirm",
  text: "Confirm plan",
  tag: "button",
  rect: { x: 160, y: 110, width: 280, height: 110 },
  styles: { color: "rgb(24, 35, 51)" },
};

const image = {
  path: "/session-only/capture.jpg",
  hostId: "host_browser",
  mimeType: "image/jpeg",
  data: jpeg,
  width: 900,
  height: 600,
};

const imageReference = {
  kind: "project-image",
  projectId: "project_artifact",
  path: "uploads/result.png",
  mimeType: "image/png",
  alt: "Updated layout preview",
  visualRequestId: "visual-request-1",
  role: "result",
};

function observation() {
  return {
    id: state.observationId,
    targetId: frame.targetId,
    documentId: "00ad5b1d-6f84-46cd-8872-05919099574d",
    url: frame.url,
    title: frame.title,
    viewport: {
      width: 900,
      height: 600,
      scrollX: 0,
      scrollY: 160,
      dpr: 2,
      scale: 1,
    },
    elements: [element],
  };
}

const nativeFetch = fetch.bind(globalThis);

const sdk = createBrowserOmnyoSdk({
  baseUrl: location.origin,
  fetch: async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );

    const project =
      /^\/api\/v1\/projects\/([^/]+)\/attachments(?:\/content)?$/u.exec(
        url.pathname,
      )?.[1];

    if (project !== undefined) {
      if (init?.method === "POST") {
        const file = init.body.get("file");

        if (!(file instanceof Blob))
          throw new Error("Expected a real multipart image upload");
        calls.push({
          method: "attachments.upload",
          projectId: project,
          mimeType: file.type,
          bytes: file.size,
        });

        return Response.json({
          type: "localImage",
          sourceProjectId: project,
          path: `uploads/note-${calls.length}.jpg`,
          name: "visual-note.jpg",
          mimeType: file.type,
          sizeBytes: file.size,
        });
      }

      calls.push({
        method: "attachments.read",
        projectId: project,
        path: url.searchParams.get("path"),
      });

      return new Response(png, { headers: { "content-type": "image/png" } });
    }

    if (url.pathname === "/api/v1/threads/thr_origin")
      return Response.json({ id: "thr_origin", projectId: "project_origin" });

    if (url.pathname === "/api/v1/plugins/tidy/rpc/ready_ids")
      return Response.json({
        ok: true,
        result: { threadIds: [], revision: 1 },
      });
    throw new Error(`Unexpected fixture SDK request: ${url.pathname}`);
  },
});

const card = {
  threadId: "thr_origin",
  revision: 1,
  status: "needs-you",
  phase: "test",
  goal: "Review the new layout",
  headline: "The visual result is ready",
  sidebarSummary: null,
  blocker: null,
  next: "Alex opens the chat to answer its native question",
  facts: [],
  visuals: [{ title: "Updated layout", preview: imageReference }],
  stale: false,
  unseen: true,
  updatedAt: Date.now(),
};

const thread = {
  id: "thr_origin",
  projectId: "project_origin",
  displayTitle: "Design review",
  isArchived: false,
  isHidden: false,
  href: "/fixture/native-question",
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  hasPendingInteraction: true,
  activity: {
    workflows: 0,
    backgroundAgents: 0,
    backgroundCommands: 0,
    planMode: 0,
    goals: 0,
  },
};

const sidebar = { status: "ready", threads: [thread] };

const rpc = {
  async call(method, input) {
    const contract = browserContract[method] ?? glanceContract[method];

    if (contract === undefined)
      throw new Error(`Unexpected fixture RPC: ${method}`);
    contract.input.parse(input);
    const complete = (result) => contract.output.parse(result);
    calls.push({ method, input });

    if (method === "cards.index") return complete({ cards: [card] });

    if (method === "card.markSeen") {
      state.markSeen += 1;

      return complete({ ok: true });
    }

    if (method === "observe") {
      state.observation += 1;
      state.observationId = crypto.randomUUID();
      state.stale = false;

      return complete({ observation: observation(), image });
    }

    if (method === "inspect") {
      if (state.stale)
        throw new Error(
          "This frozen image is stale. Refresh the selection; your note is kept.",
        );
      const { elements: _elements, ...context } = observation();

      return complete({ observation: context, element, image });
    }

    if (method === "viewport")
      return complete({
        preset: input.preset,
        viewport: observation().viewport,
      });
    throw new Error(`Unexpected fixture RPC: ${method}`);
  },
};

Object.assign(globalThis, {
  __omnyoPluginRuntime: {
    react: React,
    pluginSdkApp: {
      useSdk: () => sdk,
      useRpc: () => rpc,
      useComposers: () => [foreignComposer, originComposer],
      useRealtime: () => {},
      useRealtimeConnectionState: () => "connected",
      experimental_usePluginId: () => "glance-ui-proof",
      experimental_useSidebarThreads: () => sidebar,
      experimental_ImagePreview: PluginImagePreview,
      experimental_Icon: Icon,
      experimental_useAppNavigate: () => ({
        toThread: (threadId) => state.navigated.push(threadId),
      }),
    },
  },
  __orcaVisualProof: { ready: false, calls, urls, state, nativeFetch },
});

function App() {
  const [mounted, setMounted] = useState(true);
  const [frozen, setFrozen] = useState(false);

  return (
    <main data-qa-root="">
      <section
        id="visual-ui"
        className="mb-6 space-y-3"
        aria-label="Browser annotation fixture"
      >
        <h1 className="text-lg font-medium">Browser visual feedback</h1>
        <VisualControls
          threadId="thr_origin"
          sessionId="fd32facb-f730-4b8a-b994-b3c1d989cc4c"
          frame={frame}
          onFrozenChange={setFrozen}
        />
        <p data-frozen-state="">{frozen ? "Frozen" : "Live"}</p>
      </section>
      <section id="glance-ui" aria-label="Glance visual fixture">
        <button type="button" onClick={() => setMounted((value) => !value)}>
          {mounted ? "Close result views" : "Open result views"}
        </button>
        {mounted ? <GlancePage /> : null}
      </section>
      {mounted ? (
        <section
          id="lazy-ui"
          className="lazy-fixture"
          aria-label="Offscreen image fixture"
        >
          <ProjectImagePreview
            image={{
              ...imageReference,
              projectId: "project_offscreen",
              alt: "Offscreen result preview",
            }}
            title="Offscreen result"
          />
        </section>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

globalThis.__orcaVisualProof.ready = true;
