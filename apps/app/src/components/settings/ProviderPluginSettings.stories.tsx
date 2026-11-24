import { useEffect, useState } from "react";
import type { JsonValue } from "@omnyo/domain";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { PluginPendingInteractionComposer } from "@/components/plugin/PluginPendingInteractionComposer";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { loadPluginAppDefinition } from "../../../.ladle/plugin-app-module";
import { PI_EXTENSION_UI_RENDERER_ID } from "../../../../../plugins/provider-pi/src/extension-ui-contract";

installTestPluginRuntime();

export default { title: "plugins/Provider settings" };

const ACP_PLUGIN_ID = "provider-acp-next";

const PI_PLUGIN_ID = "provider-pi";

const acpApp = collectPluginAppRegistrations(
  await loadPluginAppDefinition(
    import.meta.glob<unknown>(
      "../../../../../plugins/provider-acp-next/app.tsx",
    ),
  ),
);

const piApp = collectPluginAppRegistrations(
  await loadPluginAppDefinition(
    import.meta.glob<unknown>("../../../../../plugins/provider-pi/app.tsx"),
  ),
);

const registrySection = acpApp.settingsSections.find(
  (section) => section.id === "registry",
)!;

function agent(
  id: string,
  name: string,
  status: string,
  description: string,
  icon: string | null = null,
) {
  const command =
    status === "manual-install" || status === "built-in"
      ? null
      : `npx -y ${id}@latest`;

  return {
    id,
    name,
    version: "1.4.2",
    description,
    repository: null,
    website: null,
    authors: [],
    license: null,
    launch:
      command === null
        ? null
        : { kind: "npx", package: `${id}@latest`, args: [], env: {} },
    binaryPlatforms: [],
    providerId: `acp-${id}`,
    status,
    command,
    icon,
  };
}

const AGENTS = [
  agent(
    "goose",
    "Goose",
    "update-available",
    "An open-source, extensible AI agent that goes beyond code suggestions.",
  ),
  agent(
    "gemini",
    "Gemini CLI",
    "added",
    "Google’s open-source agent that brings Gemini to your terminal.",
  ),
  agent(
    "opencode",
    "OpenCode",
    "available",
    "The AI coding agent built for the terminal.",
  ),
  agent(
    "qwen-code",
    "Qwen Code",
    "available",
    "A command-line agent tuned for Qwen coding models.",
  ),
  agent(
    "cursor",
    "Cursor Agent",
    "built-in",
    "Cursor’s coding agent over the Agent Client Protocol.",
  ),
  agent(
    "junie",
    "Junie",
    "manual-install",
    "JetBrains’ coding agent, shipped as a native binary.",
  ),
];

type RegistryResponse =
  | { kind: "ready"; error: string | null; agents: unknown[] }
  | { kind: "pending" };

function installRegistryRpc(response: RegistryResponse): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!url.includes(`/api/v1/plugins/${ACP_PLUGIN_ID}/rpc/`)) {
      return originalFetch(input, init);
    }

    if (response.kind === "pending") {
      return new Promise<Response>(() => {});
    }

    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          fetchedAt: Date.now(),
          error: response.error,
          agents: response.agents,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function RegistrySettings({ response }: { response: RegistryResponse }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const restore = installRegistryRpc(response);
    setReady(true);

    return restore;
  }, [response]);

  const Section = registrySection.component;

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      {ready ? (
        <PluginSlotMount
          pluginId={ACP_PLUGIN_ID}
          slotKind="settingsSection"
          slotId="registry"
        >
          <Section />
        </PluginSlotMount>
      ) : null}
    </div>
  );
}

const loaded: RegistryResponse = { kind: "ready", error: null, agents: AGENTS };

const savedCopy: RegistryResponse = {
  kind: "ready",
  error: "The ACP registry answered 503.",
  agents: AGENTS.slice(0, 3),
};

const pending: RegistryResponse = { kind: "pending" };

export function AcpRegistry() {
  return <RegistrySettings response={loaded} />;
}

export function AcpRegistrySavedCopy() {
  return <RegistrySettings response={savedCopy} />;
}

export function AcpRegistryLoading() {
  return <RegistrySettings response={pending} />;
}

function PiDialog({ title, data }: { title: string; data: JsonValue }) {
  useEffect(() => {
    setPluginSlotRegistrations(
      PI_PLUGIN_ID,
      makePluginRegistrationSet({
        pendingInteractions: piApp.pendingInteractions,
      }),
    );

    return () => removePluginSlotRegistrations(PI_PLUGIN_ID);
  }, []);

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-3xl flex-col justify-end p-4">
      <PluginPendingInteractionComposer
        collapsedByDefault={false}
        interaction={{
          id: "pi-extension-ui-demo",
          threadId: "thread-demo",
          createdAt: 1,
        }}
        origin="provider"
        request={{
          pluginId: PI_PLUGIN_ID,
          rendererId: PI_EXTENSION_UI_RENDERER_ID,
          title,
          data,
        }}
      />
    </div>
  );
}

export function PiInputDialog() {
  return (
    <PiDialog
      title="Name the release branch"
      data={{
        requestId: "ui-input",
        method: "input",
        message: "Which branch should the release extension cut from?",
        placeholder: "release/1.4",
      }}
    />
  );
}

export function PiEditorDialog() {
  return (
    <PiDialog
      title="Edit the commit message"
      data={{
        requestId: "ui-editor",
        method: "editor",
        message: "Review the commit message before Pi commits.",
        prefill:
          "Fix the usage footer columns\n\nExplain what each number means.",
      }}
    />
  );
}

export function PiConfirmDialog() {
  return (
    <PiDialog
      title="Run the migration?"
      data={{
        requestId: "ui-confirm",
        method: "confirm",
        message: "This modifies files in the workspace.",
      }}
    />
  );
}
