import semverGte from "semver/functions/gte.js";
import semverValid from "semver/functions/valid.js";
import { sdk } from "@/lib/sdk";
import { useMemo } from "react";
import type { ExperimentalPluginBrowserPage } from "@omnyo/plugin-sdk";
import type { OmnyoDesktopBrowserApi } from "@omnyo/desktop-contract";
import { getDesktopBrowserApi, getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";
import {
  usePluginSlots,
  type PluginBrowserToolbarActionSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

interface CreatePluginBrowserPageArgs {
  desktopBrowser: OmnyoDesktopBrowserApi | null;
  desktopVersion: string | null;
  pluginId: string;
  tabId: string;
  threadId: string;
}

export function createPluginBrowserPage({
  desktopBrowser,
  desktopVersion,
  pluginId,
  tabId,
  threadId,
}: CreatePluginBrowserPageArgs): ExperimentalPluginBrowserPage | null {
  const evaluate = desktopBrowser?.evaluate;
  const onPageMessage = desktopBrowser?.onPageMessage;

  if (evaluate === undefined || onPageMessage === undefined) {
    return null;
  }

  return {
    async evaluate(expression, options) {
      const version = semverValid(desktopVersion ?? "");

      if (version === null || !semverGte(version, "0.46.246"))
        throw new Error(
          "Update Omnyo desktop to 0.46.246 or newer to evaluate browser pages.",
        );

      const result = await evaluate({
        tabId,
        expression,
        world: options?.world ?? "isolated",
        channel: pluginId,
      });

      if (!result.ok) {
        throw new Error(result.error);
      }

      return result.value;
    },
    async experimental_capture() {
      const target = await desktopBrowser?.getTarget?.();

      if (target === undefined || target === null)
        throw new Error("Desktop browser capture is unavailable");

      return sdk.experimental_desktopBrowsers.captureTab({
        ...target,
        tabId,
        threadId,
      });
    },
    onMessage(listener) {
      return onPageMessage((message) => {
        if (message.tabId === tabId && message.channel === pluginId) {
          listener(message.data);
        }
      });
    },
  };
}

interface PluginBrowserToolbarActionProps {
  slot: PluginBrowserToolbarActionSlot;
  threadId: string;
  tabId: string;
  url: string;
  isCompactViewport: boolean;
}

function PluginBrowserToolbarAction({
  slot,
  threadId,
  tabId,
  url,
  isCompactViewport,
}: PluginBrowserToolbarActionProps) {
  const page = useMemo(
    () =>
      createPluginBrowserPage({
        desktopBrowser: getDesktopBrowserApi(),
        desktopVersion: getOmnyoDesktopInfo()?.version ?? null,
        pluginId: slot.pluginId,
        tabId,
        threadId,
      }),
    [slot.pluginId, tabId, threadId],
  );

  const Component = slot.component;

  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="browserToolbarAction"
      slotId={slot.id}
      instanceId={`${threadId}/${tabId}`}
      crashFallback={null}
    >
      <span
        role="group"
        aria-label={slot.title}
        className="flex shrink-0 items-center"
      >
        <Component
          threadId={threadId}
          tabId={tabId}
          url={url}
          isCompactViewport={isCompactViewport}
          experimental_page={page}
        />
      </span>
    </PluginSlotMount>
  );
}

export function PluginBrowserToolbarActions({
  threadId,
  tabId,
  url,
  isCompactViewport,
}: {
  threadId: string;
  tabId: string;
  url: string;
  isCompactViewport: boolean;
}) {
  const { browserToolbarActions } = usePluginSlots();

  if (browserToolbarActions.length === 0) return null;

  return browserToolbarActions.map((slot) => (
    <PluginBrowserToolbarAction
      key={`${slot.pluginId}/${slot.id}/${slot.generation}/${threadId}/${tabId}`}
      slot={slot}
      threadId={threadId}
      tabId={tabId}
      url={url}
      isCompactViewport={isCompactViewport}
    />
  ));
}
