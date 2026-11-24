import { getThread } from "@omnyo/db";
import type { ThreadEvent, ThreadEventWithItem } from "@omnyo/domain";
import { isThreadEventWithItem, parseNamespacedGlyph } from "@omnyo/domain";
import type { HostDaemonEventEnvelope } from "@omnyo/host-daemon-contract";
import { findPluginAgentTool } from "../services/plugins/plugin-agent-contributions.js";
import { undeclaredIconProblem } from "@omnyo/plugin-sdk/internal/host-policy";
import type { AppDeps } from "../types.js";

export type PresentationIconValidationDeps = Pick<
  AppDeps,
  "db" | "logger" | "providerRegistry"
>;

const OMNYO_TOOL_SERVER = "omnyo";

interface PresentationIconSite {
  glyph: string;
  glyphPluginId: string;
  event: ThreadEventWithItem;
}

function presentationIconSiteOf(
  event: ThreadEvent,
): PresentationIconSite | null {
  if (!isThreadEventWithItem(event)) {
    return null;
  }

  const glyph =
    "presentation" in event.item
      ? event.item.presentation?.icon.glyph
      : undefined;

  const parsed = glyph === undefined ? null : parseNamespacedGlyph(glyph);

  if (glyph === undefined || parsed === null) {
    return null;
  }

  return { glyph, glyphPluginId: parsed.pluginId, event };
}

function isRegisteredOmnyoToolIcon(site: PresentationIconSite): boolean {
  const { item } = site.event;

  if (item.type !== "toolCall" || item.server !== OMNYO_TOOL_SERVER) {
    return false;
  }

  const tool = findPluginAgentTool(item.tool);

  return (
    tool !== undefined &&
    tool.pluginId === site.glyphPluginId &&
    tool.record.presentation?.icon?.glyph === site.glyph
  );
}

function presentationIconProblem(
  deps: PresentationIconValidationDeps,
  site: PresentationIconSite,
  providerId: string | null,
): string | null {
  if (isRegisteredOmnyoToolIcon(site)) {
    return null;
  }

  const registration =
    providerId === null ? null : deps.providerRegistry.get(providerId);

  if (registration === null) {
    return `presentation.icon "${site.glyph}" names a plugin icon, but the thread's provider has no live registration to check it against`;
  }

  const problem = undeclaredIconProblem(
    registration.pluginId,
    registration.iconNames,
    site.glyph,
  );

  return problem === null ? null : `presentation.icon ${problem}`;
}

function toUnhandledEvent(
  site: PresentationIconSite,
  providerId: string | null,
  reason: string,
): ThreadEvent {
  const { event } = site;

  return {
    type: "provider/unhandled",
    threadId: event.threadId,
    providerThreadId: event.providerThreadId,
    providerId: providerId ?? "unknown",
    rawType: `presentation/icon:${event.item.type}`,
    rawEvent: {
      jsonrpc: "2.0",
      method: event.type,
      params: {
        itemId: event.item.id,
        itemType: event.item.type,
        glyph: site.glyph,
        reason,
      },
    },
    scope: event.scope,
    ...(event.item.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: event.item.parentToolCallId }),
  };
}

export function validatePresentationIcons(
  deps: PresentationIconValidationDeps,
  envelopes: readonly HostDaemonEventEnvelope[],
): HostDaemonEventEnvelope[] {
  return envelopes.map((envelope) => {
    const site = presentationIconSiteOf(envelope.event);

    if (site === null) {
      return envelope;
    }

    const providerId =
      getThread(deps.db, site.event.threadId)?.providerId ?? null;

    const reason = presentationIconProblem(deps, site, providerId);

    if (reason === null) {
      return envelope;
    }

    deps.logger.warn(
      {
        threadId: envelope.threadId,
        eventType: envelope.event.type,
        itemType: site.event.item.type,
        glyph: site.glyph,
        reason,
      },
      "Rejected provider presentation icon at ingest",
    );

    return { ...envelope, event: toUnhandledEvent(site, providerId, reason) };
  });
}
