import { z } from "zod";
import {
  desktopBrowserBrokerRequestSchema,
  desktopBrowserCommandSchema,
  desktopBrowserCommandSchemas,
  desktopBrowserResultSchemas,
} from "./desktop-browser.js";
import {
  desktopBrowserImportFailureReasonSchema,
  desktopBrowserImportSelectionSchema,
} from "./desktop-browser-import.js";

export const DESKTOP_BROWSER_COOKIE_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export const desktopBrowserCookieSyncSourceSchema =
  desktopBrowserImportSelectionSchema.strict();

export type DesktopBrowserCookieSyncSource = z.infer<
  typeof desktopBrowserCookieSyncSourceSchema
>;

const timestamp = z.number().int().nonnegative();

const count = z.number().int().nonnegative();

export const desktopBrowserCookieSyncRunSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      at: timestamp,
      imported: count,
      removed: count,
      skipped: count,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      at: timestamp,
      reason: desktopBrowserImportFailureReasonSchema,
    })
    .strict(),
]);

export type DesktopBrowserCookieSyncRun = z.infer<
  typeof desktopBrowserCookieSyncRunSchema
>;

export const desktopBrowserCookieSyncStatusSchema = z
  .object({
    source: desktopBrowserCookieSyncSourceSchema.nullable(),
    running: z.boolean(),
    lastRun: desktopBrowserCookieSyncRunSchema.nullable(),
    nextRunAt: timestamp.nullable(),
  })
  .strict();

export type DesktopBrowserCookieSyncStatus = z.infer<
  typeof desktopBrowserCookieSyncStatusSchema
>;

const instanceCommandSchema =
  desktopBrowserCommandSchemas["desktop.browser.list_import_sources"];

export const desktopBrowserCookieSyncCommandSchemas = {
  "desktop.browser.cookie_sync_status": instanceCommandSchema.extend({
    type: z.literal("desktop.browser.cookie_sync_status"),
  }),
  "desktop.browser.cookie_sync_configure": instanceCommandSchema.extend({
    type: z.literal("desktop.browser.cookie_sync_configure"),
    source: desktopBrowserCookieSyncSourceSchema.nullable(),
  }),
  "desktop.browser.cookie_sync_run": instanceCommandSchema.extend({
    type: z.literal("desktop.browser.cookie_sync_run"),
  }),
};

export const desktopBrowserCookieSyncResultSchemas = {
  "desktop.browser.cookie_sync_status": desktopBrowserCookieSyncStatusSchema,
  "desktop.browser.cookie_sync_configure": desktopBrowserCookieSyncStatusSchema,
  "desktop.browser.cookie_sync_run": desktopBrowserCookieSyncStatusSchema,
};

export const desktopBrowserBrokerCommandSchema = z.discriminatedUnion("type", [
  ...desktopBrowserCommandSchema.options,
  desktopBrowserCookieSyncCommandSchemas["desktop.browser.cookie_sync_status"],
  desktopBrowserCookieSyncCommandSchemas[
    "desktop.browser.cookie_sync_configure"
  ],
  desktopBrowserCookieSyncCommandSchemas["desktop.browser.cookie_sync_run"],
]);

export type DesktopBrowserBrokerCommand = z.infer<
  typeof desktopBrowserBrokerCommandSchema
>;

export const desktopBrowserBrokerResultSchemas = {
  ...desktopBrowserResultSchemas,
  ...desktopBrowserCookieSyncResultSchemas,
};

export type DesktopBrowserBrokerResult<
  T extends DesktopBrowserBrokerCommand["type"] =
    DesktopBrowserBrokerCommand["type"],
> = z.infer<(typeof desktopBrowserBrokerResultSchemas)[T]>;

export const desktopBrowserBrokerCommandRequestSchema =
  desktopBrowserBrokerRequestSchema.extend({
    command: desktopBrowserBrokerCommandSchema,
  });
