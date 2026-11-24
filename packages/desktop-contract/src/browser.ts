import { z } from "zod";
import {
  desktopBrowserImportSelectionSchema,
  type DesktopBrowserCookieSyncSource,
  type DesktopBrowserCookieSyncStatus,
  type DesktopBrowserImportOutcome,
  type DesktopBrowserImportSelection,
  type DesktopBrowserImportSource,
} from "@omnyo/host-daemon-contract";

export const OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH = 4096;

export const OMNYO_DESKTOP_BROWSER_MAX_TITLE_LENGTH = 1024;

export const omnyoDesktopBrowserTargetSchema = z
  .object({
    hostId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();

export type OmnyoDesktopBrowserTarget = z.infer<
  typeof omnyoDesktopBrowserTargetSchema
>;

export const omnyoDesktopBrowserControlSchema = z
  .object({
    leaseId: z.string().min(1),
    controllerLabel: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type OmnyoDesktopBrowserControl = z.infer<
  typeof omnyoDesktopBrowserControlSchema
>;

export const omnyoDesktopBrowserControlStateSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    control: omnyoDesktopBrowserControlSchema.nullable(),
  })
  .strict();

export type OmnyoDesktopBrowserControlState = z.infer<
  typeof omnyoDesktopBrowserControlStateSchema
>;

export const omnyoDesktopBrowserRevealRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    desktopTarget: omnyoDesktopBrowserTargetSchema,
  })
  .strict();

export type OmnyoDesktopBrowserRevealRequest = z.infer<
  typeof omnyoDesktopBrowserRevealRequestSchema
>;

const omnyoDesktopBrowserViewBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();

export type OmnyoDesktopBrowserViewBounds = z.infer<
  typeof omnyoDesktopBrowserViewBoundsSchema
>;

export interface OmnyoDesktopBrowserViewportBounds {
  width: number;
  height: number;
}

interface ClampIntegerToRangeArgs {
  max: number;
  min: number;
  value: number;
}

interface ClampOmnyoDesktopBrowserViewBoundsArgs {
  bounds: OmnyoDesktopBrowserViewBounds;
  viewport: OmnyoDesktopBrowserViewportBounds;
}

function clampIntegerToRange(args: ClampIntegerToRangeArgs): number {
  return Math.min(Math.max(args.value, args.min), args.max);
}

export function clampOmnyoDesktopBrowserViewBounds(
  args: ClampOmnyoDesktopBrowserViewBoundsArgs,
): OmnyoDesktopBrowserViewBounds {
  const viewportRight = Math.max(0, Math.round(args.viewport.width));
  const viewportBottom = Math.max(0, Math.round(args.viewport.height));

  const x = clampIntegerToRange({
    value: args.bounds.x,
    min: 0,
    max: viewportRight,
  });

  const y = clampIntegerToRange({
    value: args.bounds.y,
    min: 0,
    max: viewportBottom,
  });

  const right = clampIntegerToRange({
    value: args.bounds.x + args.bounds.width,
    min: x,
    max: viewportRight,
  });

  const bottom = clampIntegerToRange({
    value: args.bounds.y + args.bounds.height,
    min: y,
    max: viewportBottom,
  });

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export const omnyoDesktopBrowserAttachRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    url: z.string().max(OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH),
    existingOnly: z.literal(true).optional(),
    bounds: omnyoDesktopBrowserViewBoundsSchema,
    visible: z.boolean(),
  })
  .strict();

export type OmnyoDesktopBrowserAttachRequest = z.infer<
  typeof omnyoDesktopBrowserAttachRequestSchema
>;

export const omnyoDesktopBrowserNavigateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();

export type OmnyoDesktopBrowserNavigateRequest = z.infer<
  typeof omnyoDesktopBrowserNavigateRequestSchema
>;

export const omnyoDesktopBrowserSetBoundsRequestSchema = z
  .object({
    tabId: z.string().min(1),
    bounds: omnyoDesktopBrowserViewBoundsSchema,
  })
  .strict();

export type OmnyoDesktopBrowserSetBoundsRequest = z.infer<
  typeof omnyoDesktopBrowserSetBoundsRequestSchema
>;

export const omnyoDesktopBrowserSetVisibleRequestSchema = z
  .object({
    tabId: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();

export type OmnyoDesktopBrowserSetVisibleRequest = z.infer<
  typeof omnyoDesktopBrowserSetVisibleRequestSchema
>;

export const omnyoDesktopBrowserTabRefSchema = z
  .object({
    tabId: z.string().min(1),
  })
  .strict();

export const omnyoDesktopBrowserHostFocusRequestSchema = z
  .object({
    tabId: z.string().min(1).nullable(),
  })
  .strict();

export type OmnyoDesktopBrowserTabRef = z.infer<
  typeof omnyoDesktopBrowserTabRefSchema
>;

export const omnyoDesktopBrowserStateSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().max(OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title: z.string().max(OMNYO_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    errorText: z
      .string()
      .max(OMNYO_DESKTOP_BROWSER_MAX_TITLE_LENGTH)
      .nullable(),
  })
  .strict();

export type OmnyoDesktopBrowserState = z.infer<
  typeof omnyoDesktopBrowserStateSchema
>;

export const omnyoDesktopBrowserOpenTabRequestSchema = z
  .object({
    url: z.string().min(1).max(OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();

export type OmnyoDesktopBrowserOpenTabRequest = z.infer<
  typeof omnyoDesktopBrowserOpenTabRequestSchema
>;

export const omnyoDesktopBrowserScopedOpenTabRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(OMNYO_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();

export type OmnyoDesktopBrowserScopedOpenTabRequest = z.infer<
  typeof omnyoDesktopBrowserScopedOpenTabRequestSchema
>;

const OMNYO_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH = 8_388_608;

export const omnyoDesktopBrowserSnapshotSchema = z
  .object({
    tabId: z.string().min(1),
    dataUrl: z
      .string()
      .max(OMNYO_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH)
      .nullable(),
  })
  .strict();

export type OmnyoDesktopBrowserSnapshot = z.infer<
  typeof omnyoDesktopBrowserSnapshotSchema
>;

export const OMNYO_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH = 1024;

export const omnyoDesktopBrowserFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).max(OMNYO_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH),
    forward: z.boolean(),
    newSession: z.boolean(),
  })
  .strict();

export type OmnyoDesktopBrowserFindInPageRequest = z.infer<
  typeof omnyoDesktopBrowserFindInPageRequestSchema
>;

export const omnyoDesktopBrowserStopFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(["clearSelection", "keepSelection", "activateSelection"]),
  })
  .strict();

export type OmnyoDesktopBrowserStopFindInPageRequest = z.infer<
  typeof omnyoDesktopBrowserStopFindInPageRequestSchema
>;

export const omnyoDesktopBrowserFindResultSchema = z
  .object({
    tabId: z.string().min(1),
    requestId: z.number().int(),
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    finalUpdate: z.boolean(),
  })
  .strict();

export type OmnyoDesktopBrowserFindResult = z.infer<
  typeof omnyoDesktopBrowserFindResultSchema
>;

export const OMNYO_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH = 4_000_000;

export const OMNYO_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH = 256;

export const omnyoDesktopBrowserPageWorldSchema = z.enum(["main", "isolated"]);

export const omnyoDesktopBrowserEvaluateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    expression: z
      .string()
      .min(1)
      .max(OMNYO_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH),
    world: omnyoDesktopBrowserPageWorldSchema,
    channel: z
      .string()
      .min(1)
      .max(OMNYO_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
  })
  .strict();

export type OmnyoDesktopBrowserEvaluateRequest = z.infer<
  typeof omnyoDesktopBrowserEvaluateRequestSchema
>;

export const omnyoDesktopBrowserEvaluateResultSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({ ok: z.literal(true), value: z.json() }).strict(),
    z.object({ ok: z.literal(false), error: z.string() }).strict(),
  ],
);

export type OmnyoDesktopBrowserEvaluateResult = z.infer<
  typeof omnyoDesktopBrowserEvaluateResultSchema
>;

export const omnyoDesktopBrowserPageMessageSchema = z
  .object({
    tabId: z.string().min(1),
    channel: z
      .string()
      .min(1)
      .max(OMNYO_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
    data: z.json(),
  })
  .strict();

export type OmnyoDesktopBrowserPageMessage = z.infer<
  typeof omnyoDesktopBrowserPageMessageSchema
>;

export type OmnyoDesktopBrowserPageMessageHandler = (
  message: OmnyoDesktopBrowserPageMessage,
) => void;

export type OmnyoDesktopBrowserStateHandler = (
  state: OmnyoDesktopBrowserState,
) => void;

export type OmnyoDesktopBrowserOpenTabHandler = (
  request: OmnyoDesktopBrowserOpenTabRequest,
) => void;

export type OmnyoDesktopBrowserScopedOpenTabHandler = (
  request: OmnyoDesktopBrowserScopedOpenTabRequest,
) => void;

export type OmnyoDesktopBrowserSnapshotHandler = (
  snapshot: OmnyoDesktopBrowserSnapshot,
) => void;

export type OmnyoDesktopBrowserFocusHandler = (tabId: string) => void;

export type OmnyoDesktopBrowserFindResultHandler = (
  result: OmnyoDesktopBrowserFindResult,
) => void;

export type OmnyoDesktopBrowserUnsubscribe = () => void;

export const omnyoDesktopBrowserImportCookiesRequestSchema =
  desktopBrowserImportSelectionSchema;

export type OmnyoDesktopBrowserImportCookiesRequest = z.infer<
  typeof omnyoDesktopBrowserImportCookiesRequestSchema
>;

export type OmnyoDesktopBrowserImportSourcesResult = {
  sources: DesktopBrowserImportSource[];
  recommended?: DesktopBrowserImportSelection;
};

export type OmnyoDesktopBrowserImportCookiesResult =
  DesktopBrowserImportOutcome;

export interface OmnyoDesktopBrowserApi {
  listImportSources?(): Promise<OmnyoDesktopBrowserImportSourcesResult>;
  importCookies?(
    request: OmnyoDesktopBrowserImportCookiesRequest,
  ): Promise<OmnyoDesktopBrowserImportCookiesResult>;
  openFullDiskAccessSettings?(): void;
  cookieSyncStatus?(): Promise<DesktopBrowserCookieSyncStatus>;
  configureCookieSync?(
    source: DesktopBrowserCookieSyncSource | null,
  ): Promise<DesktopBrowserCookieSyncStatus>;
  runCookieSync?(): Promise<DesktopBrowserCookieSyncStatus>;
  getTarget?(): Promise<OmnyoDesktopBrowserTarget | null>;
  getControl?(tabId: string): Promise<OmnyoDesktopBrowserControlState | null>;
  releaseControl?(tabId: string): void;
  onControl?(
    listener: (state: OmnyoDesktopBrowserControlState) => void,
  ): OmnyoDesktopBrowserUnsubscribe;
  onReveal?(
    listener: (request: OmnyoDesktopBrowserRevealRequest) => void,
  ): OmnyoDesktopBrowserUnsubscribe;
  attach(request: OmnyoDesktopBrowserAttachRequest): void;
  detach(tabId: string): void;
  navigate(request: OmnyoDesktopBrowserNavigateRequest): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  focus?(tabId: string): void;
  setHostFocus?(tabId: string | null): void;
  setBounds(request: OmnyoDesktopBrowserSetBoundsRequest): void;
  setVisible(request: OmnyoDesktopBrowserSetVisibleRequest): void;
  setVisibleWithoutFocus?(request: OmnyoDesktopBrowserSetVisibleRequest): void;
  onState(
    listener: OmnyoDesktopBrowserStateHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  onOpenTab(
    listener: OmnyoDesktopBrowserOpenTabHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  onScopedOpenTab?(
    listener: OmnyoDesktopBrowserScopedOpenTabHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  onFocus?(
    listener: OmnyoDesktopBrowserFocusHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  onSnapshot?(
    listener: OmnyoDesktopBrowserSnapshotHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  findInPage?(request: OmnyoDesktopBrowserFindInPageRequest): void;
  stopFindInPage?(request: OmnyoDesktopBrowserStopFindInPageRequest): void;
  onFindResult?(
    listener: OmnyoDesktopBrowserFindResultHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
  evaluate?(
    request: OmnyoDesktopBrowserEvaluateRequest,
  ): Promise<OmnyoDesktopBrowserEvaluateResult>;
  onPageMessage?(
    listener: OmnyoDesktopBrowserPageMessageHandler,
  ): OmnyoDesktopBrowserUnsubscribe;
}
