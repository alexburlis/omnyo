import { getThread } from "@omnyo/db";
import type { ExtensionKind, JsonValue, ThreadEvent } from "@omnyo/domain";
import { coreThreadStateSchema, parseExtensionKind } from "@omnyo/domain";
import type { HostDaemonEventEnvelope } from "@omnyo/host-daemon-contract";
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "@omnyo/plugin-sdk";
import { sliceUtf16Head } from "@omnyo/text-utils";
import type { AppDeps } from "../types.js";

export const EXTENSION_PAYLOAD_MAX_BYTES = 64 * 1024;

export const EXTENSION_REJECTION_REASON_MAX_CHARS = 4 * 1024;

export const EXTENSION_VALIDATION_TIMEOUT_MS = 5_000;

const REASON_TRUNCATION_MARKER = " ... [truncated]";

const VALIDATION_TIMED_OUT = Symbol("validation timed out");

export type ExtensionPayloadValidationDeps = Pick<
  AppDeps,
  "db" | "logger" | "providerRegistry"
>;

interface ExtensionPayloadSite {
  surface: "item" | "state";
  kind: ExtensionKind;
  payload: JsonValue;
  eventType: ThreadEvent["type"];
  threadId: string;
  providerThreadId: string;
  scope: ThreadEvent["scope"];
  parentToolCallId: string | undefined;
}

function extensionSiteOf(event: ThreadEvent): ExtensionPayloadSite | null {
  switch (event.type) {
    case "item/started":
    case "item/completed":
      return event.item.type === "extension"
        ? {
            surface: "item",
            kind: event.item.kind,
            payload: event.item.payload,
            eventType: event.type,
            threadId: event.threadId,
            providerThreadId: event.providerThreadId,
            scope: event.scope,
            parentToolCallId: event.item.parentToolCallId,
          }
        : null;
    case "thread/extensionState/updated":
      return {
        surface: "state",
        kind: event.kind,
        payload: event.payload,
        eventType: event.type,
        threadId: event.threadId,
        providerThreadId: event.providerThreadId,
        scope: event.scope,
        parentToolCallId: undefined,
      };
    default:
      return null;
  }
}

type ValidationOutcome = { ok: true } | { ok: false; reason: string };

function issuePathSegments(path: StandardSchemaV1Issue["path"]): string[] {
  if (path === undefined) {
    return [];
  }

  if (!Array.isArray(path)) {
    return [String(path)];
  }

  return path.map((segment) =>
    typeof segment === "object" && segment !== null
      ? String(segment.key)
      : String(segment),
  );
}

async function validateAgainstSchema(
  schema: StandardSchemaV1,
  payload: JsonValue,
): Promise<ValidationOutcome> {
  let result: StandardSchemaV1Result<unknown> | typeof VALIDATION_TIMED_OUT;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    result = await Promise.race([
      schema["~standard"].validate(payload),
      new Promise<typeof VALIDATION_TIMED_OUT>((resolve) => {
        timeout = setTimeout(
          () => resolve(VALIDATION_TIMED_OUT),
          EXTENSION_VALIDATION_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: `validator threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (result === VALIDATION_TIMED_OUT) {
    return {
      ok: false,
      reason: `validator did not finish within ${EXTENSION_VALIDATION_TIMEOUT_MS} ms`,
    };
  }

  if (result.issues !== undefined) {
    return {
      ok: false,
      reason: result.issues
        .map((issue) => {
          const path = issuePathSegments(issue.path).join(".");

          return path === "" ? issue.message : `${path}: ${issue.message}`;
        })
        .join("; "),
    };
  }

  return { ok: true };
}

function extensionOwnershipProblem(
  deps: ExtensionPayloadValidationDeps,
  site: ExtensionPayloadSite,
  providerId: string | null,
): string | null {
  const { pluginId } = parseExtensionKind(site.kind);

  const registration =
    providerId === null ? null : deps.providerRegistry.get(providerId);

  if (registration === null) {
    const provider =
      providerId === null
        ? "the thread's provider"
        : `the thread's provider "${providerId}"`;

    return `extension kind "${site.kind}" names plugin "${pluginId}", but ${provider} has no live registration to check it against`;
  }

  if (registration.pluginId !== pluginId) {
    return `extension kind "${site.kind}" is owned by plugin "${pluginId}", but the thread's provider "${providerId}" is registered by plugin "${registration.pluginId}"`;
  }

  return null;
}

async function validateSite(
  deps: ExtensionPayloadValidationDeps,
  site: ExtensionPayloadSite,
  providerId: string | null,
): Promise<ValidationOutcome> {
  const coreSchema =
    site.surface === "state" ? coreThreadStateSchema(site.kind) : null;

  if (coreSchema !== null) {
    const bytes = Buffer.byteLength(JSON.stringify(site.payload));

    if (bytes > EXTENSION_PAYLOAD_MAX_BYTES) {
      return {
        ok: false,
        reason: `payload is ${bytes} bytes; the limit is ${EXTENSION_PAYLOAD_MAX_BYTES}`,
      };
    }

    return validateAgainstSchema(coreSchema, site.payload);
  }

  const ownership = extensionOwnershipProblem(deps, site, providerId);

  if (ownership !== null) {
    return { ok: false, reason: ownership };
  }

  const declared = deps.providerRegistry.getExtensionKindSchemas(site.kind);
  const schema = declared?.[site.surface];

  if (schema === undefined) {
    const { pluginId, name } = parseExtensionKind(site.kind);

    return {
      ok: false,
      reason:
        declared === null
          ? `plugin "${pluginId}" declares no extension kind "${name}"`
          : `plugin "${pluginId}" declares extension kind "${name}" with no ${site.surface} schema`,
    };
  }

  const bytes = Buffer.byteLength(JSON.stringify(site.payload));

  if (bytes > EXTENSION_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      reason: `payload is ${bytes} bytes; the limit is ${EXTENSION_PAYLOAD_MAX_BYTES}`,
    };
  }

  return validateAgainstSchema(schema, site.payload);
}

function boundedReason(reason: string): string {
  if (reason.length <= EXTENSION_REJECTION_REASON_MAX_CHARS) {
    return reason;
  }

  return `${sliceUtf16Head(reason, EXTENSION_REJECTION_REASON_MAX_CHARS - REASON_TRUNCATION_MARKER.length)}${REASON_TRUNCATION_MARKER}`;
}

function toUnhandledEvent(
  site: ExtensionPayloadSite,
  providerId: string | null,
  reason: string,
): ThreadEvent {
  const payloadBytes = Buffer.byteLength(JSON.stringify(site.payload));

  return {
    type: "provider/unhandled",
    threadId: site.threadId,
    providerThreadId: site.providerThreadId,
    providerId: providerId ?? parseExtensionKind(site.kind).pluginId,
    rawType: `extension/${site.surface}:${site.kind}`,
    rawEvent: {
      jsonrpc: "2.0",
      method: site.eventType,
      params: {
        kind: site.kind,
        ...(payloadBytes > EXTENSION_PAYLOAD_MAX_BYTES
          ? { payloadOmitted: true, payloadBytes }
          : { payload: site.payload }),
        reason: boundedReason(reason),
      },
    },
    scope: site.scope,
    ...(site.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: site.parentToolCallId }),
  };
}

export async function validateExtensionPayloads(
  deps: ExtensionPayloadValidationDeps,
  envelopes: readonly HostDaemonEventEnvelope[],
): Promise<HostDaemonEventEnvelope[]> {
  return Promise.all(
    envelopes.map(async (envelope) => {
      const site = extensionSiteOf(envelope.event);

      if (site === null) {
        return envelope;
      }

      const providerId = getThread(deps.db, site.threadId)?.providerId ?? null;
      const outcome = await validateSite(deps, site, providerId);

      if (outcome.ok) {
        return envelope;
      }

      deps.logger.warn(
        {
          threadId: envelope.threadId,
          eventType: envelope.event.type,
          extensionKind: site.kind,
          surface: site.surface,
          reason: outcome.reason,
        },
        "Rejected provider extension payload at ingest",
      );

      return {
        ...envelope,
        event: toUnhandledEvent(site, providerId, outcome.reason),
      };
    }),
  );
}
