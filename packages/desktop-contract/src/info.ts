import type { WorkflowImportReference } from "./workflow-import.js";
import type { OmnyoDesktopServerChoice } from "./servers.js";
import { z } from "zod";
import type { OmnyoDesktopBrowserApi } from "./browser.js";
import type { OmnyoDesktopWindowFindRequest } from "./find.js";
import { omnyoDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId } from "@omnyo/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

const omnyoDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);

export const omnyoDesktopInfoSchema = z.object({
  downloadState: omnyoDesktopDownloadStateSchema.optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: omnyoDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
});

export type OmnyoDesktopInfo = z.infer<typeof omnyoDesktopInfoSchema>;

export const omnyoDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
  })
  .strict();

export type OmnyoDesktopWindowState = z.infer<
  typeof omnyoDesktopWindowStateSchema
>;

export const omnyoDesktopThemeSchema = z.enum(["system", "light", "dark"]);

export type OmnyoDesktopTheme = z.infer<typeof omnyoDesktopThemeSchema>;

export const omnyoDesktopClipboardContentSchema = z
  .object({
    text: z.string(),
    html: z.string().optional(),
  })
  .strict();

export type OmnyoDesktopClipboardContent = z.infer<
  typeof omnyoDesktopClipboardContentSchema
>;

export const omnyoDesktopNativeFileRequestSchema = z
  .object({
    count: z.number().int().min(0).max(64),
    paths: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(63),
            path: z.string().min(1).max(8192),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .refine(
    ({ count, paths }) =>
      paths.every((item) => item.index < count) &&
      new Set(paths.map((item) => item.index)).size === paths.length,
  );

export const omnyoDesktopNativeFileClassificationsSchema = z
  .array(
    z.union([
      z
        .object({
          kind: z.literal("directory"),
          path: z.string().min(1).max(8192),
        })
        .strict(),
      z
        .object({
          kind: z.literal("file"),
          path: z.string().min(1).max(8192).optional(),
        })
        .strict(),
      z.null(),
    ]),
  )
  .max(64);

export type OmnyoDesktopNativeFileClassification = z.infer<
  typeof omnyoDesktopNativeFileClassificationsSchema
>[number];

export const omnyoDesktopZoomCommandSchema = z.enum(["in", "out", "reset"]);

export type OmnyoDesktopZoomCommand = z.infer<
  typeof omnyoDesktopZoomCommandSchema
>;

export const OMNYO_DESKTOP_MIN_ZOOM_PERCENT = 50;

export const OMNYO_DESKTOP_MAX_ZOOM_PERCENT = 300;

export type OmnyoDesktopInfoChangeHandler = (info: OmnyoDesktopInfo) => void;

export type OmnyoDesktopInfoUnsubscribe = () => void;

export type OmnyoDesktopWindowStateChangeHandler = (
  state: OmnyoDesktopWindowState,
) => void;

export type OmnyoDesktopZoomChangeHandler = (zoomFactor: number) => void;

export type OmnyoDesktopOpenNewTabHandler = () => void;

export type OmnyoDesktopAppCommandHandler = (command: AppCommandId) => void;

export type OmnyoDesktopCloseWindowRequestHandler = () => boolean;

export type OmnyoDesktopOpenThreadHandler = (threadId: string) => void;

export interface OmnyoDesktopApi extends OmnyoDesktopInfo {
  browser: OmnyoDesktopBrowserApi;
  takeWorkflowImport?(): Promise<WorkflowImportReference | null>;
  onWorkflowImport?(listener: () => void): () => void;
  getServerChoices?(): Promise<OmnyoDesktopServerChoice[]>;
  onServerChoicesChange?(
    listener: (choices: OmnyoDesktopServerChoice[]) => void,
  ): () => void;
  selectServer?(id: string): void;
  checkForUpdates(): Promise<OmnyoDesktopInfo>;
  getInfo(): Promise<OmnyoDesktopInfo>;
  focusWindow?(): void;
  getWindowState?(): Promise<OmnyoDesktopWindowState>;
  installUpdate(): Promise<void>;
  onChange(
    listener: OmnyoDesktopInfoChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: OmnyoDesktopWindowStateChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  onZoomChange?(
    listener: OmnyoDesktopZoomChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  zoom?(command: OmnyoDesktopZoomCommand): void;
  onOpenNewTab?(
    listener: OmnyoDesktopOpenNewTabHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  onAppCommand?(
    listener: OmnyoDesktopAppCommandHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: OmnyoDesktopCloseWindowRequestHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  onOpenThread?(
    listener: OmnyoDesktopOpenThreadHandler,
  ): OmnyoDesktopInfoUnsubscribe;
  openWindowFind?(request: OmnyoDesktopWindowFindRequest): void;
  openDataDirectory?(): Promise<void>;
  openExternalUrl(url: string): void;
  openServerDaemonLogs?(): Promise<void>;
  reloadWindow?(): void;
  setSplitNavigationEnabled?(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void;
  setAttention?(active: boolean): void;
  setTheme(theme: OmnyoDesktopTheme): void;
  writeClipboard?(content: OmnyoDesktopClipboardContent): Promise<void>;
  resolveNativeFiles?(
    files: readonly File[],
  ): Promise<readonly OmnyoDesktopNativeFileClassification[]>;
}
