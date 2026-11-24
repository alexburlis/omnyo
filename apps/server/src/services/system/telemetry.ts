import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { deleteSecretFile } from "@omnyo/secret-storage";
import { join } from "node:path";
import { DEFAULTS } from "@omnyo/config/defaults";
import type { RecordTelemetryEventRequest } from "@omnyo/server-contract";
import {
  claimUsageWeek,
  getAppSettings,
  migrateUsageConsent,
  readUsageActors,
  readUsageAttemptedWeek,
  setAppSettings,
  writeUsageActors,
  type DbConnection,
  type UsageActor,
} from "@omnyo/db";
import {
  publicUsageListingSchema,
  productUsageEventSchema,
  productUsageReportSchema,
  usageProofSchema,
  USAGE_RAW_RETENTION_DAYS,
  USAGE_REQUEST_AGENT,
  type ProductUsageEvent,
  type ProductUsageReport,
  type UsageConsentRequest,
  type UsageConsentResponse,
  type UsagePreview,
  type UsageStatus,
} from "@omnyo/domain/usage-telemetry";
import type { ServerLogger } from "../../types.js";

const context = new AsyncLocalStorage<{
  proof?: string;
  interactive: boolean;
  activity?: boolean;
}>();

export type TelemetryEvent =
  | {
      name: "operation_finished";
      properties: {
        operation: "new_chat" | "message";
        outcome: "accepted" | "failed";
        latency: "under_1s" | "1_to_5s" | "5_to_30s" | "over_30s";
      };
    }
  | { name: "app_started" | "telemetry_disabled" }
  | {
      name: "thread_created";
      properties: { is_child_thread: boolean };
    }
  | {
      name: "user_message_sent";
      properties: {
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
      };
    }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    }
  | RecordTelemetryEventRequest;

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  setEnabled(enabled: boolean): void;
  status(proof?: string): UsageStatus;
  choose(request: UsageConsentRequest, proof?: string): UsageConsentResponse;
  erase(proof: string): Promise<UsageStatus>;
  preview(): UsagePreview;
  prune(): void;
  stop(): void;
}

interface CreateTelemetryServiceArgs {
  collectorUrl?: string;
  countRegion?: string;
  db: DbConnection;
  appVersion: string;
  dataDir: string;
  enabled: boolean;
  logger: ServerLogger;
}

export function runWithUsageRequest<T>(
  request: { proof?: string; interactive: boolean; activity?: boolean },
  callback: () => T,
): T {
  return context.run(request, callback);
}

export function usageSubject(proof: string): string {
  return createHash("sha256")
    .update(Buffer.from(usageProofSchema.parse(proof), "hex"))
    .digest("hex");
}

export function utcWeekStart(now: number): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));

  return date.toISOString().slice(0, 10);
}

const disabledStatus = (): UsageStatus => ({
  count: {
    choice: "unset",
    effective: false,
    reason: "disabled",
    noticeRequired: false,
    attemptedWeek: null,
  },
  product: {
    choice: "unset",
    effective: false,
    reason: "disabled",
    erasure: "none",
    rawRetentionDays: 30,
  },
});

export function createNoopTelemetryService(): TelemetryService {
  return {
    capture() {},
    setEnabled() {},
    prune() {},
    stop() {},
    status: disabledStatus,
    choose: () => ({ status: disabledStatus() }),
    erase: async () => disabledStatus(),
    preview: () => ({
      count: { method: "POST", path: "/metrics/active-week", body: "" },
      product: [],
      destination: null,
    }),
  };
}

function productEvent(event: TelemetryEvent): ProductUsageEvent | null {
  switch (event.name) {
    case "thread_created":
      return null;
    case "operation_finished":
      return {
        event: "operation",
        properties: event.properties,
      };
    case "user_message_sent":
      return event.properties.is_child_thread
        ? null
        : {
            event: "feature_used",
            properties: {
              feature:
                event.properties.message_source === "queued_message"
                  ? "queued_message"
                  : "chat",
            },
          };
    case "plugin_installed":
      return { event: "feature_used", properties: { feature: "plugin" } };
    case "onboarding_step_reached":
    case "onboarding_step_completed":
    case "onboarding_step_skipped":
      return {
        event: "onboarding",
        properties: {
          ...event.properties,
          outcome:
            event.name === "onboarding_step_reached"
              ? "reached"
              : event.name === "onboarding_step_completed"
                ? "completed"
                : "skipped",
        },
      };
    case "new_thread_submit":
      return null;
    case "onboarding_sign_in":
      return {
        event: "operation",
        properties: {
          operation: "agent_sign_in",
          outcome:
            event.properties.outcome === "ready"
              ? "accepted"
              : event.properties.outcome === "exited"
                ? "cancelled"
                : event.properties.outcome,
          latency: "unknown",
          ...(event.properties.outcome === "failed"
            ? { failure_reason: event.properties.failure_reason ?? "unknown" }
            : {}),
        },
      };
    default:
      return null;
  }
}

export async function createTelemetryService(
  args: CreateTelemetryServiceArgs,
): Promise<TelemetryService> {
  migrateUsageConsent(args.db);
  const settings = getAppSettings(args.db);
  await deleteSecretFile(join(args.dataDir, "telemetry-id"));
  const allowed = args.enabled && args.appVersion !== DEFAULTS.appVersion;
  let legacyEnabled = settings.telemetryEnabled;

  const pending = new Map<
    string,
    { proof: string; key: string; report: ProductUsageReport }
  >();

  let nextDrainAt = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;

  const requests = new Map<
    AbortController,
    { purpose: "count" | "product"; subject?: string }
  >();

  function actors(): UsageActor[] {
    const now = Date.now();
    const stored = readUsageActors(args.db);

    const fresh = stored.filter(
      (actor) =>
        actor.withdrawnAt === null ||
        actor.withdrawnAt > now - USAGE_RAW_RETENTION_DAYS * 86400000,
    );

    for (const actor of fresh)
      if (actor.day !== new Date(now).toISOString().slice(0, 10)) {
        actor.day = new Date(now).toISOString().slice(0, 10);
        actor.keys = [];
      }

    if (JSON.stringify(fresh) !== JSON.stringify(stored))
      writeUsageActors(args.db, fresh);

    return fresh;
  }

  function actorFor(proof?: string): UsageActor | undefined {
    if (!proof || !usageProofSchema.safeParse(proof).success) return undefined;
    const subject = usageSubject(proof);

    return actors().find((actor) => actor.subject === subject);
  }

  function status(proof?: string): UsageStatus {
    const consent = getAppSettings(args.db).usageConsent;
    const actor = actorFor(proof);
    const hardDisabled = !allowed || !legacyEnabled;
    const configured = args.collectorUrl !== undefined;
    const regional = args.countRegion === "US" && consent.noticeVersion === 1;

    const countGranted =
      consent.count === "granted" || (consent.count === "unset" && regional);

    const productGranted =
      consent.product === "granted" &&
      actor !== undefined &&
      actor.withdrawnAt === null;

    return {
      count: {
        choice: consent.count,
        effective: !hardDisabled && configured && countGranted,
        reason: hardDisabled
          ? "disabled"
          : !configured
            ? "not-configured"
            : consent.count === "declined"
              ? "declined"
              : consent.count === "granted"
                ? "granted"
                : regional
                  ? "regional-default"
                  : "consent-required",
        noticeRequired:
          !hardDisabled &&
          configured &&
          args.countRegion === "US" &&
          consent.count === "unset" &&
          consent.noticeVersion === 0,
        attemptedWeek: readUsageAttemptedWeek(args.db),
      },
      product: {
        choice:
          actor?.withdrawnAt !== null && actor !== undefined
            ? "declined"
            : actor
              ? "granted"
              : "unset",
        effective: !hardDisabled && configured && productGranted,
        reason: hardDisabled
          ? "disabled"
          : !configured
            ? "not-configured"
            : productGranted
              ? "granted"
              : actor?.withdrawnAt !== null && actor !== undefined
                ? "declined"
                : "consent-required",
        erasure: actor?.erasure ?? "none",
        rawRetentionDays: 30,
      },
    };
  }

  function invalidate(target?: {
    purpose: "count" | "product";
    subject?: string;
  }): void {
    for (const [key, item] of pending)
      if (
        !target ||
        (target.purpose === "product" &&
          (target.subject === undefined ||
            target.subject === item.report.subject))
      )
        pending.delete(key);

    for (const [request, scope] of requests) {
      if (
        target &&
        (scope.purpose !== target.purpose ||
          (target.subject !== undefined && scope.subject !== target.subject))
      )
        continue;
      request.abort();
      requests.delete(request);
    }
  }

  function send(
    path: string,
    body: string,
    permitted: () => boolean,
    subject?: string,
  ): void {
    if (!args.collectorUrl || !permitted()) return;
    const controller = new AbortController();
    requests.set(controller, {
      purpose: path === "/metrics/active-week" ? "count" : "product",
      ...(subject ? { subject } : {}),
    });

    if (!permitted()) {
      requests.delete(controller);

      return;
    }

    void fetch(new URL(path, args.collectorUrl), {
      method: "POST",
      headers: {
        "content-type": body === "" ? "text/plain" : "application/json",
        "user-agent": USAGE_REQUEST_AGENT,
      },
      body,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .catch(() => {
        args.logger.debug("Usage report was dropped");
      })
      .finally(() => requests.delete(controller));
  }

  function captureProduct(event: ProductUsageEvent, proof: string): void {
    if (!status(proof).product.effective) return;
    const actor = actorFor(proof);

    if (!actor) return;
    const parsed = productUsageEventSchema.parse(event);

    const key =
      parsed.event === "activity" ? "activity" : JSON.stringify(parsed);

    const prior = actor.keys.find((entry) => entry.key === key);

    if (prior && (parsed.event === "activity" || prior.count >= 100)) return;

    if (!prior && actor.keys.length >= 256) return;
    const count = (prior?.count ?? 0) + 1;

    if (prior) prior.count = count;
    else actor.keys.push({ key, count, sentCount: 0 });
    writeUsageActors(
      args.db,
      actors().map((row) => (row.subject === actor.subject ? actor : row)),
    );

    const report = productUsageReportSchema.parse({
      ...parsed,
      count,
      subject: actor.subject,
      day: actor.day,
    });

    pending.set(`${actor.subject}:${actor.day}:${key}`, { proof, key, report });
  }

  function drain(): void {
    const now = Date.now();

    if (now < nextDrainAt) return;
    nextDrainAt = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
    const items = [...pending.values()];
    pending.clear();

    for (const item of items) {
      if (
        item.report.day < new Date(now - 86400000).toISOString().slice(0, 10) ||
        !status(item.proof).product.effective
      )
        continue;
      const rows = actors();
      const actor = rows.find((row) => row.subject === item.report.subject);

      const counter =
        actor?.day === item.report.day
          ? actor.keys.find((row) => row.key === item.key)
          : undefined;

      if (counter) counter.sentCount = item.report.count;
      writeUsageActors(args.db, rows);
      send(
        "/metrics/product",
        JSON.stringify(item.report),
        () => status(item.proof).product.effective,
        item.report.subject,
      );
    }
  }

  writeUsageActors(
    args.db,
    actors().map((actor) => ({
      ...actor,
      keys: actor.keys
        .filter((counter) => counter.sentCount > 0)
        .map((counter) => ({ ...counter, count: counter.sentCount })),
    })),
  );

  return {
    status,
    prune() {
      actors();
      drain();
    },
    stop: invalidate,
    setEnabled(enabled) {
      if (legacyEnabled === enabled) return;
      legacyEnabled = enabled;

      if (!enabled) invalidate();

      if (!enabled)
        writeUsageActors(
          args.db,
          actors().map((actor) => ({
            ...actor,
            withdrawnAt: actor.withdrawnAt ?? Date.now(),
            keys: [],
          })),
        );
    },
    choose(request, proof) {
      const current = getAppSettings(args.db);

      if (!legacyEnabled)
        writeUsageActors(
          args.db,
          actors().map((row) => ({
            ...row,
            withdrawnAt: row.withdrawnAt ?? Date.now(),
            keys: [],
          })),
        );

      const consent = {
        ...current.usageConsent,
        ...(request.purpose === "product"
          ? { productSource: request.source }
          : { countSource: request.source }),
      };

      let resultProof: string | undefined;

      if (request.purpose === "notice") consent.noticeVersion = 1;
      else if (request.purpose === "count") consent.count = request.choice;
      else if (request.choice === "granted") {
        consent.product = "granted";

        if (allowed && args.collectorUrl) {
          const previous = actorFor(proof);

          if (previous?.withdrawnAt === null) resultProof = proof;
          else {
            const rows = actors();

            if (rows.length >= 64)
              throw new Error("The local analytics client limit is reached");
            resultProof = randomBytes(32).toString("hex");
            rows.push({
              subject: usageSubject(resultProof),
              grantedAt: Date.now(),
              source: request.source,
              activated: false,
              withdrawnAt: null,
              erasure: "none",
              day: new Date().toISOString().slice(0, 10),
              keys: [],
            });
            writeUsageActors(args.db, rows);
          }
        }
      } else {
        const actor = actorFor(proof);

        if (actor)
          writeUsageActors(
            args.db,
            actors().map((row) =>
              row.subject === actor.subject
                ? { ...row, withdrawnAt: Date.now(), keys: [] }
                : row,
            ),
          );
        else if (!actors().some((row) => row.withdrawnAt === null))
          consent.product = "declined";
      }

      if (request.choice === "declined") {
        if (request.purpose === "count") invalidate({ purpose: "count" });

        if (
          request.purpose === "product" &&
          proof &&
          usageProofSchema.safeParse(proof).success
        )
          invalidate({ purpose: "product", subject: usageSubject(proof) });
      }

      legacyEnabled = true;
      setAppSettings(args.db, {
        ...current,
        telemetryEnabled: true,
        usageConsent: consent,
      });

      return {
        status: status(resultProof ?? proof),
        ...(resultProof ? { proof: resultProof } : {}),
      };
    },
    async erase(proof) {
      usageProofSchema.parse(proof);
      const actor = actorFor(proof);

      invalidate({ purpose: "product", subject: usageSubject(proof) });
      writeUsageActors(
        args.db,
        actors().map((row) =>
          row.subject === actor?.subject
            ? {
                ...row,
                withdrawnAt: row.withdrawnAt ?? Date.now(),
                erasure: "pending",
                keys: [],
              }
            : row,
        ),
      );

      let erasure: "pending" | "complete" = "pending";

      if (!args.collectorUrl)
        return {
          ...status(proof),
          product: { ...status(proof).product, effective: false, erasure },
        };

      try {
        const response = await fetch(
          new URL("/metrics/product-erasure", args.collectorUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": USAGE_REQUEST_AGENT,
            },
            body: JSON.stringify({ proof }),
            redirect: "error",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(5000),
          },
        );

        if (response.status === 204) {
          erasure = "complete";
          writeUsageActors(
            args.db,
            actors().map((row) =>
              row.subject === actor?.subject
                ? { ...row, erasure: "complete" }
                : row,
            ),
          );
        }
      } catch {
        args.logger.debug("Analytics erasure remains pending");
      }

      return {
        ...status(proof),
        product: { ...status(proof).product, effective: false, erasure },
      };
    },
    preview: () => ({
      count: { method: "POST", path: "/metrics/active-week", body: "" },
      product: [
        {
          subject: "0".repeat(64),
          day: "2026-01-01",
          count: 1,
          event: "activity",
          properties: { first: true },
        },
        {
          subject: "0".repeat(64),
          day: "2026-01-01",
          count: 1,
          event: "feature_used",
          properties: { feature: "chat" },
        },
        {
          subject: "0".repeat(64),
          day: "2026-01-01",
          count: 1,
          event: "first_accepted_action",
          properties: { since_grant: "under_1m" },
        },
      ],
      destination: args.collectorUrl ?? null,
    }),
    capture(event) {
      const request = context.getStore();

      if (!request?.interactive) return;

      const qualifies =
        request.activity !== false &&
        (event.name === "thread_created"
          ? !event.properties.is_child_thread
          : event.name === "user_message_sent" &&
            !event.properties.is_child_thread);

      if (
        qualifies &&
        status().count.effective &&
        claimUsageWeek(args.db, utcWeekStart(Date.now()))
      )
        send("/metrics/active-week", "", () => status().count.effective);

      if (!request.proof) return;

      if (
        request.activity === false &&
        (event.name === "thread_created" || event.name === "user_message_sent")
      )
        return;
      const product = productEvent(event);

      if (qualifies) {
        const actor = actorFor(request.proof);

        if (actor && status(request.proof).product.effective) {
          const first = !actor.activated;

          if (first)
            writeUsageActors(
              args.db,
              actors().map((row) =>
                row.subject === actor.subject
                  ? { ...row, activated: true }
                  : row,
              ),
            );
          captureProduct(
            { event: "activity", properties: { first } },
            request.proof,
          );
          const elapsed = Date.now() - actor.grantedAt;

          if (first && elapsed >= 0)
            captureProduct(
              {
                event: "first_accepted_action",
                properties: {
                  since_grant:
                    elapsed < 60_000
                      ? "under_1m"
                      : elapsed < 600_000
                        ? "1_to_10m"
                        : elapsed < 3_600_000
                          ? "10_to_60m"
                          : "over_60m",
                },
              },
              request.proof,
            );
        }
      }

      if (product) captureProduct(product, request.proof);

      if (
        event.name === "plugin_installed" &&
        event.properties.provenance !== "direct"
      ) {
        const listing = publicUsageListingSchema.safeParse(
          event.properties.plugin_id,
        );

        if (listing.success)
          captureProduct(
            {
              event: "public_plugin_installed",
              properties: { listing: listing.data },
            },
            request.proof,
          );
      }
    },
  };
}
