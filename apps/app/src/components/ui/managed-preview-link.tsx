import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import {
  parseLoopbackPreviewUrl,
  rewriteLocalhostLinkHref,
} from "@omnyo/client-core";
import {
  previewListResponseSchema,
  previewStatusSchema,
  type PreviewStatus,
} from "@omnyo/server-contract";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  invalidateManagedPreviewStatus,
  invalidateManagedPreviews,
  setManagedPreviewStatus,
} from "@/hooks/cache-owners/managed-preview-cache-owner";
import {
  managedPreviewStatusQueryKey,
  managedPreviewsQueryKey,
} from "@/hooks/queries/query-keys";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { apiClient } from "@/lib/api-server";
import { wsManager } from "@/lib/ws";
import type { MarkdownPreviewLinkHandler } from "./markdown-link.js";
import { PreviewAnnouncementContext } from "./preview-announcements.js";

interface ManagedPreviewLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href"
> {
  href: string;
  threadId: string;
  enabled: boolean;
  onOpenLink?: MarkdownPreviewLinkHandler;
}

function sameEndpoint(left: string, right: string): boolean {
  const a = parseLoopbackPreviewUrl(left);
  const b = parseLoopbackPreviewUrl(right);

  return (
    a !== null &&
    b !== null &&
    a.protocol === b.protocol &&
    a.port === b.port &&
    (a.hostname === "[::1]") === (b.hostname === "[::1]")
  );
}

async function requireOk(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Could not reach the preview's computer");

  return response.json();
}

export function useManagedPreviewList(threadId: string, visible: boolean) {
  return useQuery({
    queryKey: managedPreviewsQueryKey(threadId),
    queryFn: async ({ signal }) =>
      previewListResponseSchema.parse(
        await requireOk(
          await apiClient.previews.$get(
            { query: { threadId } },
            { init: { signal } },
          ),
        ),
      ),
    staleTime: 10000,
    refetchInterval: visible ? 30000 : false,
    refetchOnWindowFocus: "always",
  });
}

export function useManagedPreviewStatus(
  previewId: string | undefined,
  visible: boolean,
) {
  return useQuery({
    queryKey: managedPreviewStatusQueryKey(previewId),
    enabled: previewId !== undefined && visible,
    queryFn: async ({ signal }) => {
      if (previewId === undefined) throw new Error("No registered preview");

      return previewStatusSchema.parse(
        await requireOk(
          await apiClient.previews[":previewId"].status.$get(
            { param: { previewId } },
            { init: { signal } },
          ),
        ),
      );
    },
    staleTime: 2000,
    refetchInterval: (query) =>
      visible ? (query.state.data?.state === "starting" ? 1000 : 5000) : false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

export function freshManagedPreviewStatus(observed: {
  data: PreviewStatus | undefined;
  isError: boolean;
}): PreviewStatus | null {
  return observed.data !== undefined &&
    !observed.isError &&
    Date.now() - observed.data.checkedAt < 15000
    ? observed.data
    : null;
}

export function useManagedPreviewVisibility<TElement extends Element>() {
  const ref = useRef<TElement>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const target = ref.current;

    if (target === null || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, []);

  return { ref, visible };
}

export function useManagedPreviewRefresh(
  threadId: string,
  previewId: string | undefined,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refresh = () =>
      invalidateManagedPreviews({ queryClient, threadId, previewId });

    const offConnected = wsManager.onConnected(refresh);

    const offChanged = wsManager.onChanged((message) => {
      if (message.entity === "host") refresh();
    });

    return () => {
      offConnected();
      offChanged();
    };
  }, [queryClient, threadId, previewId]);
}

export function routeManagedPreviewHref(args: {
  enabled: boolean;
  href: string;
  previewId: string | undefined;
  sourceHostId: string | undefined;
  viewerHostId: string | null | undefined;
}): string | undefined {
  return rewriteLocalhostLinkHref({
    enabled: args.enabled,
    href: args.href,
    sourceHostId: args.sourceHostId,
    viewerHostId: args.viewerHostId,
    remoteBaseUrl:
      args.previewId === undefined
        ? undefined
        : `/preview/${encodeURIComponent(args.previewId)}`,
  });
}

export function openManagedPreviewInApp(
  event: MouseEvent<HTMLAnchorElement>,
  routedHref: string | undefined,
  onOpenLink: MarkdownPreviewLinkHandler | undefined,
): void {
  if (
    routedHref &&
    onOpenLink?.({ href: new URL(routedHref, window.location.href).href })
  )
    event.preventDefault();
}

export function ManagedPreviewLink({
  href,
  threadId,
  enabled,
  onOpenLink,
  children,
  ...props
}: ManagedPreviewLinkProps) {
  const { localDaemonHostId } = useHostDaemon();
  const queryClient = useQueryClient();
  const announce = useContext(PreviewAnnouncementContext);
  const descriptionId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hadFocus = useRef(false);
  const initiated = useRef(false);
  const lastKnown = useRef<"online" | "stopped" | null>(null);

  const { ref: clusterRef, visible } =
    useManagedPreviewVisibility<HTMLSpanElement>();

  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && buttonRef.current === document.activeElement)
      hadFocus.current = true;
    buttonRef.current = node;
  }, []);

  const previews = useManagedPreviewList(threadId, visible);

  const binding = previews.data?.previews.find((preview) =>
    sameEndpoint(preview.url, href),
  );

  const sourceHost = previews.data?.sourceHost;
  const host = sourceHost?.name ?? "Preview computer";
  const ownerId = binding?.hostId ?? sourceHost?.id;
  const local = ownerId !== undefined && ownerId === localDaemonHostId;
  const previewId = binding?.id;
  const observed = useManagedPreviewStatus(previewId, visible);

  const restart = useMutation({
    mutationFn: async () => {
      if (previewId === undefined) throw new Error("No saved start command");

      return previewStatusSchema.parse(
        await requireOk(
          await apiClient.previews[":previewId"].restart.$post({
            param: { previewId },
            json: { requestId: nanoid() },
          }),
        ),
      );
    },
    onSuccess: (status) =>
      setManagedPreviewStatus({ queryClient, previewId, status }),
    onError: () => {
      announce("Didn't start: Could not reach the preview's computer");
      initiated.current = false;
      void invalidateManagedPreviewStatus({ queryClient, previewId });
    },
  });

  const freshStatus = freshManagedPreviewStatus(observed);

  const state = restart.isPending
    ? "starting"
    : restart.isError && restart.submittedAt > observed.dataUpdatedAt
      ? "unknown"
      : (freshStatus?.state ?? "unknown");

  const detail =
    restart.isError && restart.submittedAt > observed.dataUpdatedAt
      ? "Could not reach the preview's computer"
      : (freshStatus?.detail ?? null);

  useEffect(() => {
    if (state === "online" || state === "stopped") lastKnown.current = state;

    if (!initiated.current || state === "starting" || restart.isPending) return;

    if (state === "online") {
      announce("Server running");

      if (hadFocus.current) linkRef.current?.focus();
      hadFocus.current = false;
      initiated.current = false;
    } else if (state === "error" || state === "conflict") {
      announce(
        `Didn't start: ${detail ?? (state === "conflict" ? "The port is in use" : "The server did not become ready")}`,
      );
      initiated.current = false;
    }
  }, [state, detail, announce, restart.isPending]);
  useManagedPreviewRefresh(threadId, previewId);

  const url = new URL(href);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const starting = state === "starting";
  const red = state === "stopped" || state === "conflict" || state === "error";

  const lastSeen =
    lastKnown.current === null
      ? ""
      : ` · last seen ${lastKnown.current === "online" ? "running" : "stopped"}`;

  const unmanaged = binding === undefined && previews.isSuccess;
  const routable = local || binding !== undefined || !enabled;

  const routedHref = routeManagedPreviewHref({
    enabled,
    href,
    previewId: binding?.id,
    sourceHostId: ownerId,
    viewerHostId: localDaemonHostId,
  });

  const label = unmanaged
    ? local
      ? ""
      : "Only on " + host
    : state === "host-offline"
      ? `${host} offline${lastSeen}`
      : state === "stopped"
        ? "Stopped"
        : state === "conflict"
          ? `Port ${port} in use`
          : state === "error"
            ? "Didn't start"
            : state === "unknown" && detail
              ? "Status unknown"
              : "";

  const reason =
    state === "conflict"
      ? "by another app"
      : state === "error" || state === "unknown"
        ? detail
        : null;

  const description = unmanaged
    ? local
      ? `No saved start command on ${host}`
      : `Only on ${host}`
    : state === "online"
      ? `Running on ${host}`
      : starting
        ? `Starting on ${host}`
        : state === "stopped"
          ? `Stopped on ${host}`
          : label || "Checking server status";

  const canRestart =
    binding !== undefined &&
    (state === "stopped" || state === "error" || starting);

  const dot =
    state === "online"
      ? "bg-success"
      : red
        ? "bg-destructive"
        : "ring-1 ring-inset ring-subtle-foreground";

  const action = (
    <button
      ref={setButtonRef}
      type="button"
      aria-label={`Restart server on ${host}`}
      aria-disabled={starting}
      aria-busy={starting}
      className="relative inline-flex items-center gap-1 h-5 px-1.5 rounded-md border border-border bg-background text-xs font-medium text-foreground hover:bg-(--state-hover) active:bg-(--state-active) focus-visible:ring-2 focus-visible:ring-ring aria-disabled:text-muted-foreground aria-disabled:cursor-default aria-disabled:hover:bg-background pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:gap-1.5 before:absolute before:inset-x-0 before:-inset-y-0.5 pointer-coarse:before:-inset-y-1"
      onClick={() => {
        if (starting) return;
        initiated.current = true;
        hadFocus.current = false;
        restart.mutate();
      }}
    >
      <Icon
        name={starting ? "Spinner" : "RotateCcw"}
        className="size-3 pointer-coarse:size-3.5"
        aria-hidden="true"
      />
      {starting ? "Starting…" : "Restart"}
    </button>
  );

  return (
    <>
      {routable ? (
        <a
          {...props}
          ref={linkRef}
          href={routedHref}
          title={
            enabled && binding !== undefined && !local
              ? "Opens privately through Omnyo"
              : `Opens on ${host}`
          }
          aria-describedby={descriptionId}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words [overflow-wrap:anywhere] underline underline-offset-2"
          onClick={(event) =>
            openManagedPreviewInApp(event, routedHref, onOpenLink)
          }
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )}{" "}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            ref={clusterRef}
            className="text-xs font-medium text-muted-foreground"
          >
            <span id={descriptionId} className="sr-only">
              {description}
            </span>
            {starting || (unmanaged && local) ? null : (
              <span className="whitespace-nowrap">
                <span
                  aria-hidden="true"
                  className={`inline-block size-1.5 pointer-coarse:size-2 rounded-full align-middle ${unmanaged ? "ring-1 ring-inset ring-subtle-foreground" : dot}`}
                />
                {label ? <span className="ml-1.5">{label}</span> : null}
              </span>
            )}
            {reason ? (
              <span className="font-normal text-subtle-foreground">
                {" "}
                · {reason}
              </span>
            ) : null}
            {canRestart ? <> {action}</> : null}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {description} · port {port}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
