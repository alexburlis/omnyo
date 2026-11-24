import {
  scrubBrowserErrorEvent,
  type BrowserErrorEvent,
} from "@omnyo/process-utils/web-error-reporting-privacy";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { effectiveCrashReportsEnabled } from "../services/system/diagnostics-policy.js";
import type { AppDeps } from "../types.js";

const record = z.record(z.string(), z.unknown());

const frame = z.object({
  filename: z.string().max(2_048).optional(),
  abs_path: z.string().max(2_048).optional(),
  module: z.string().max(128).optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  in_app: z.boolean().optional(),
});

const eventSchema = z
  .object({
    event_id: z.string().regex(/^[a-f0-9]{32}$/iu),
    timestamp: z.number().finite().optional(),
    level: z.enum(["fatal", "error", "warning"]).optional(),
    message: z.string().max(4_096).optional(),
    release: z.string().max(128).optional(),
    contexts: z
      .object({
        diagnostic: record.optional(),
        artifact: record.optional(),
        pluginOverlay: record.optional(),
        shelfMove: record.optional(),
      })
      .strict()
      .optional(),
    tags: z
      .object({
        service: z.literal("web"),
        stage: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    platform: z.literal("javascript").optional(),
    environment: z.literal("production").optional(),
    fingerprint: z.array(z.string().max(128)).max(8).optional(),
    exception: z
      .object({
        values: z
          .array(
            z.object({
              type: z.string().max(128).optional(),
              value: z.string().max(4_096).optional(),
              module: z.string().max(128).optional(),
              mechanism: z
                .object({
                  type: z.string().max(128),
                  handled: z.boolean().optional(),
                })
                .optional(),
              stacktrace: z
                .object({ frames: z.array(frame).max(80) })
                .optional(),
            }),
          )
          .max(8),
      })
      .optional(),
    debug_meta: z
      .object({
        images: z
          .array(
            z.object({
              type: z.literal("sourcemap"),
              code_file: z.string().max(2_048),
              debug_id: z.string().max(64),
            }),
          )
          .max(80),
      })
      .optional(),
  })
  .strict();

const payloadSchema = z.object({ envelope: z.string().max(128_000) }).strict();

function readEvent(envelope: string): BrowserErrorEvent | null {
  try {
    const lines = envelope.split("\n");

    if (lines.length !== 3) return null;

    const item = z
      .object({ type: z.literal("event") })
      .strict()
      .safeParse(JSON.parse(lines[1] ?? ""));

    if (!item.success) return null;

    return eventSchema.parse(JSON.parse(lines[2] ?? ""));
  } catch {
    return null;
  }
}

function recipient(dsn: string): string | null {
  try {
    const url = new URL(dsn);
    const project = url.pathname.split("/").pop();

    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      !url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !project ||
      !/^\d+$/u.test(project)
    )
      return null;
    const path = url.pathname.slice(0, -project.length);

    return `${url.origin}${path}api/${project}/envelope/?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`;
  } catch {
    return null;
  }
}

export function registerWebErrorReportingRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const pending = new Set<AbortController>();
  let generation = 0;
  deps.hub.onChangedMessage((message) => {
    if (
      message.entity !== "system" ||
      !message.changes.includes("config-changed")
    )
      return;
    generation += 1;

    if (!effectiveCrashReportsEnabled(deps)) {
      for (const controller of pending) controller.abort();
      pending.clear();
    }
  });

  app.post(
    "/system/web-errors",
    bodyLimit({ maxSize: 132_000 }),
    async (context) => {
      const admittedGeneration = generation;

      if (!effectiveCrashReportsEnabled(deps)) return context.body(null, 403);
      const destination = recipient(deps.config.errorReportingDsn ?? "");

      if (destination === null) return context.body(null, 503);

      const payload = payloadSchema.safeParse(
        await context.req.json().catch(() => null),
      );

      const event = payload.success ? readEvent(payload.data.envelope) : null;

      if (event === null) return context.body(null, 400);
      const sourceRevision = event.contexts?.artifact?.sourceRevision;

      const safe = scrubBrowserErrorEvent(event, {
        service: "web",
        release: /^web-[a-f0-9]{64}$/u.test(event.release ?? "")
          ? event.release
          : "web-development",
        runtimeRelease: deps.config.appVersion,
        webOrigin: context.req.header("origin"),
        ...(typeof sourceRevision === "string" &&
        /^[a-f0-9]{40,64}$/u.test(sourceRevision)
          ? { sourceRevision }
          : {}),
      });

      if (
        !effectiveCrashReportsEnabled(deps) ||
        generation !== admittedGeneration
      )
        return context.body(null, 204);
      const controller = new AbortController();
      pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(destination, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope" },
          body: [
            JSON.stringify({ event_id: safe.event_id }),
            JSON.stringify({ type: "event" }),
            JSON.stringify(safe),
          ].join("\n"),
          redirect: "error",
          signal: controller.signal,
        });

        await response.body?.cancel();

        return context.body(null, response.ok ? 204 : 502);
      } catch {
        return context.body(null, 502);
      } finally {
        clearTimeout(timeout);
        pending.delete(controller);
      }
    },
  );
}
