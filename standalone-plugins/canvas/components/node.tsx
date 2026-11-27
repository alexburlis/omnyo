import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  experimental_FileLink,
  experimental_usePluginId,
  Markdown,
  UrlLink,
  type ExperimentalLiveFileTarget,
} from "@omnyo/plugin-sdk/app";
import type { CanvasNode, FlowLeaf, IslandAccent } from "../contract";
import type { NodeChange, Slack } from "../lib/layout";
import { useNodeMeasurement } from "./node-measurement";
import { ResponsiveMedia } from "./media";
import { CanvasConversation } from "./conversation";
import { HtmlFrame } from "./html-frame";
import { frameData } from "../lib/frame-document";
import { SemanticHtml, SemanticLayers } from "./semantic";
import { useSemanticDetail } from "./semantic-detail";
import { showsTitleTile } from "../lib/semantic";
import { BoundModule } from "./bound-module";
import type { SourceState } from "../source-contract";

const FileLink = experimental_FileLink;

export const kindLabels: Record<CanvasNode["kind"], string> = {
  note: "Note",
  image: "Image",
  video: "Video",
  file: "Deliverable",
  decision: "Decision",
  status: "Status",
  code: "Code",
  html: "Visual",
  link: "Link",
};

const toneLabels: Record<CanvasNode["tone"], string> = {
  neutral: "Neutral",
  positive: "Positive",
  warning: "Warning",
  negative: "Negative",
  info: "Info",
};

const stateLabels: Record<NonNullable<CanvasNode["state"]>, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  blocked: "Blocked",
  waiting: "Waiting",
};

export interface NodeWorkspace {
  environmentId: string | null;
  hostId: string | null;
}

export interface NodeActions {
  choose(node: CanvasNode, option: string): Promise<void>;
}

interface NodeCardProps {
  threadId?: string;
  node: CanvasNode;
  change: NodeChange;
  selected: boolean;
  workspace: NodeWorkspace;
  actions: NodeActions;
  style?: React.CSSProperties;
  emphasis?: FlowLeaf["emphasis"];
  accent?: IslandAccent;
  island?: string;
  slack?: Slack;
  trackUnit?: number;
  canvasNavigation?: boolean;
  zoom?: number;
  showContentAtAnyZoom?: boolean;
  compact?: boolean;
  sources?: readonly SourceState[];
  estimatedHeight?: number;
  remembered?: boolean;
  eager?: boolean;
  measuring?: boolean;
  measureKey?: string | null;
  onWidthChange?(id: string, width: number, trackUnit?: number): void;
  onSelect(id: string): void;
  onHeadPointerDown?(event: ReactPointerEvent<HTMLDivElement>, id: string): void;
  onMeasure?(id: string, height: number, key: string): void;
  onRealization?(id: string, realized: boolean): void;
}

export function NodeCard({
  threadId,
  node,
  change,
  selected,
  workspace,
  actions,
  style,
  emphasis,
  accent,
  island,
  slack,
  trackUnit,
  canvasNavigation = false,
  zoom = 1,
  showContentAtAnyZoom = false,
  compact = false,
  sources = [],
  estimatedHeight,
  remembered = false,
  eager = false,
  measuring = false,
  measureKey = "",
  onWidthChange,
  onSelect,
  onHeadPointerDown,
  onMeasure,
  onRealization,
}: NodeCardProps) {
  const {
    element,
    content,
    realized,
    settled,
    frameDocument,
    frameHeight,
    mediaReady,
    frameLoaded,
  } = useNodeMeasurement({
    node,
    threadId,
    eager,
    measureKey,
    remembered,
    measuring,
    onMeasure,
    onRealization,
  });

  const resize = useRef<{ x: number; width: number } | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const source = sources.find((entry) => entry.source.definition.id === node.binding?.sourceId);

  const detail = useSemanticDetail(zoom, compact);
  const tile = !showContentAtAnyZoom && showsTitleTile(detail, node.views?.overview !== undefined);

  const review =
    node.evidence?.sourceIds.some(
      (id) =>
        sources.find((entry) => entry.source.definition.id === id)?.dataset?.revision !==
        node.evidence?.revisions[id],
    ) ?? false;

  useEffect(() => setDraftWidth(null), [style?.width, node.width]);

  const cardStyle = { ...style };

  if (draftWidth !== null) cardStyle.width = draftWidth;

  if (!settled && estimatedHeight !== undefined) {
    cardStyle.height = estimatedHeight;
    cardStyle.overflow = "clip";
    cardStyle.overflowClipMargin = 10;
  }

  if (measuring) {
    cardStyle.visibility = "hidden";
    cardStyle.pointerEvents = "none";
  }

  return (
    <div
      ref={element}
      className="cnv-node"
      data-node-id={measuring ? undefined : node.id}
      data-measuring={measuring || undefined}
      aria-hidden={measuring || undefined}
      inert={measuring}
      data-content-deferred={!realized || undefined}
      data-kind={node.kind}
      data-conversation={node.conversation ? true : undefined}
      data-emphasis={emphasis}
      data-accent={accent}
      data-island={island}
      data-slack-blank={slack?.blank}
      data-slack-row={slack?.row}
      data-change={change ?? undefined}
      data-selected={selected}
      data-source-revision={source?.dataset?.revision}
      data-tile={tile}
      style={cardStyle}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLIFrameElement) frameLoaded();
      }}
      tabIndex={measuring ? undefined : 0}
      role="article"
      aria-label={`${kindLabels[node.kind]}: ${node.title ?? node.id}`}
      onPointerDown={(event) => {
        if (
          node.conversation &&
          event.target instanceof Element &&
          !event.target.closest(".cnv-node-head")
        )
          return;
        onSelect(node.id);
      }}
      onFocus={() => {
        if (!node.conversation) onSelect(node.id);
      }}
    >
      {tile ? (
        <div className="cnv-node-tile" aria-hidden="true">
          <span>{node.title ?? kindLabels[node.kind]}</span>
        </div>
      ) : null}
      {change === null ? null : (
        <span className="cnv-node-flag" data-change={change}>
          {change === "new" ? "New" : "Updated"}
        </span>
      )}
      <div className="cnv-node-head" onPointerDown={(event) => onHeadPointerDown?.(event, node.id)}>
        {node.tone === "neutral" ? null : (
          <span
            className="cnv-tone"
            data-tone={node.tone}
            role="img"
            aria-label={`${toneLabels[node.tone]} tone`}
            title={`${toneLabels[node.tone]} tone`}
          />
        )}
        <span className="cnv-kind">{kindLabels[node.kind]}</span>
        <span className="cnv-toolbar-spacer" />
        {node.pinned ? (
          <span className="cnv-muted" role="img" aria-label="Pinned" title="Pinned">
            📌
          </span>
        ) : null}
      </div>
      {node.title === null || node.kind === "decision" ? null : (
        <div className="cnv-node-title" role="heading" aria-level={2}>
          {node.title}
        </div>
      )}
      <div ref={content} className="cnv-node-content">
        {node.conversation && threadId ? (
          <CanvasConversation threadId={threadId} regionId={node.conversation.id} />
        ) : !realized ? (
          <div aria-busy="true" style={{ minHeight: 120 }} />
        ) : (
          <NodeContent
            node={node}
            accent={accent}
            workspace={workspace}
            actions={actions}
            canvasNavigation={canvasNavigation}
            zoom={zoom}
            compact={compact}
            sources={sources}
            onFrameHeight={frameHeight}
            onFrameDocument={frameDocument}
            onMediaReady={mediaReady}
          />
        )}
      </div>
      {review ? (
        <p className="cnv-module-meta cnv-evidence-review" role="status">
          Evidence changed · review this interpretation
        </p>
      ) : null}
      {selected && onWidthChange ? (
        <button
          type="button"
          className="cnv-resize-handle"
          aria-label="Resize module width"
          aria-keyshortcuts="ArrowLeft ArrowRight"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            const current = element.current?.offsetWidth ?? 360;

            const width = Math.min(
              1600,
              Math.max(240, current + (event.key === "ArrowRight" ? 40 : -40)),
            );

            if (width !== current) onWidthChange(node.id, width, trackUnit);
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            resize.current = { x: event.clientX, width: element.current?.offsetWidth ?? 360 };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const origin = resize.current;

            if (origin)
              setDraftWidth(
                Math.min(
                  1600,
                  Math.max(240, Math.round(origin.width + (event.clientX - origin.x) / zoom)),
                ),
              );
          }}
          onPointerUp={(event) => {
            const origin = resize.current;

            if (!origin) return;
            resize.current = null;

            const width = Math.min(
              1600,
              Math.max(240, Math.round(origin.width + (event.clientX - origin.x) / zoom)),
            );

            onWidthChange(node.id, width, trackUnit);
            setDraftWidth(null);
          }}
          onPointerCancel={() => {
            resize.current = null;
            setDraftWidth(null);
          }}
        />
      ) : null}
    </div>
  );
}

function NodeContent({
  node,
  accent,
  workspace,
  actions,
  canvasNavigation,
  zoom,
  compact,
  sources,
  onFrameHeight,
  onFrameDocument,
  onMediaReady,
}: {
  node: CanvasNode;
  accent?: IslandAccent;
  workspace: NodeWorkspace;
  actions: NodeActions;
  canvasNavigation: boolean;
  zoom: number;
  compact: boolean;
  sources: readonly SourceState[];
  onFrameHeight(): void;
  onFrameDocument(): void;
  onMediaReady(assetId: string): void;
}) {
  const detail = useSemanticDetail(zoom, compact);

  if (node.binding) {
    const binding = node.binding;
    const state = sources.find((entry) => entry.source.definition.id === node.binding?.sourceId);
    const authored = node.binding.view === "html";
    const bound = authored ? [node.binding.sourceId, ...(node.binding.sources ?? [])] : [];

    const data = authored
      ? frameData(
          state?.dataset ?? null,
          Object.fromEntries(
            bound.map((id) => [
              id,
              sources.find((entry) => entry.source.definition.id === id)?.dataset ?? null,
            ]),
          ),
        )
      : null;

    return (
      <SemanticLayers
        title={node.title ?? "Module"}
        accent={accent}
        views={node.views}
        detail={detail}
        compact={compact}
        canvasNavigation={canvasNavigation}
        data={data}
        onHeight={onFrameHeight}
        onDocument={onFrameDocument}
      >
        {(active) =>
          authored ? (
            <HtmlFrame
              html={node.views?.evidence ?? node.html ?? ""}
              active={active}
              title={node.title ?? "Module"}
              accent={accent}
              canvasNavigation={canvasNavigation}
              data={data}
              onHeight={onFrameHeight}
              onDocument={onFrameDocument}
            />
          ) : (
            <BoundModule
              binding={binding}
              dataset={state?.dataset ?? null}
              source={state?.source}
            />
          )
        }
      </SemanticLayers>
    );
  }

  switch (node.kind) {
    case "image":
    case "video":
      return <MediaContent node={node} zoom={zoom} onReady={onMediaReady} />;
    case "file":
      return <FileContent node={node} workspace={workspace} />;
    case "decision":
      return <DecisionContent node={node} actions={actions} />;
    case "status":
      return <StatusContent node={node} />;
    case "code":
      return <CodeContent body={node.body ?? ""} language={node.language} />;
    case "html":
      return (
        <SemanticHtml
          html={node.html ?? ""}
          title={node.title ?? "Visual"}
          accent={accent}
          views={node.views}
          zoom={zoom}
          compact={compact}
          canvasNavigation={canvasNavigation}
          onHeight={onFrameHeight}
          onDocument={onFrameDocument}
        />
      );
    case "link":
      return (
        <>
          {node.href === null ? null : <UrlLink href={node.href}>{node.href}</UrlLink>}
          <Body body={node.body} />
        </>
      );
    case "note":
      return <Body body={node.body} />;
  }
}

function Body({ body }: { body: string | null }) {
  return body === null || body.trim() === "" ? null : <Markdown content={body} />;
}

function MediaContent({
  node,
  zoom,
  onReady,
}: {
  node: CanvasNode;
  zoom: number;
  onReady(assetId: string): void;
}) {
  const pluginId = experimental_usePluginId();

  const assetId = node.assetId;

  if (assetId === null) return <Body body={node.body} />;

  const url = `/api/v1/plugins/${pluginId}/http/asset?id=${assetId}`;

  return (
    <>
      {node.kind === "video" ? (
        <BoardVideo
          url={url}
          title={node.title ?? "Board video"}
          onReady={() => onReady(assetId)}
        />
      ) : (
        <ResponsiveMedia
          assetId={assetId}
          title={node.title ?? "Board image"}
          zoom={zoom}
          onReady={onReady}
        />
      )}
      {node.body === null ? null : (
        <div className="cnv-muted" style={{ marginTop: 6 }}>
          <Markdown content={node.body} />
        </div>
      )}
    </>
  );
}

function BoardVideo({ url, title, onReady }: { url: string; title: string; onReady(): void }) {
  const [failed, setFailed] = useState(false);

  if (failed)
    return (
      <div role="alert">
        Video could not load.{" "}
        <button type="button" className="cnv-button" onClick={() => setFailed(false)}>
          Retry
        </button>
      </div>
    );

  return (
    <video
      src={url}
      aria-label={title}
      controls
      loop
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={onReady}
      onError={() => {
        setFailed(true);
        onReady();
      }}
    />
  );
}

function fileTarget(href: string, workspace: NodeWorkspace): ExperimentalLiveFileTarget | null {
  if (href.startsWith("/"))
    return workspace.hostId === null
      ? null
      : { kind: "host", hostId: workspace.hostId, path: href };

  return workspace.environmentId === null
    ? null
    : { kind: "workspace", environmentId: workspace.environmentId, path: href };
}

function FileContent({ node, workspace }: { node: CanvasNode; workspace: NodeWorkspace }) {
  const href = node.href ?? "";
  const name = href.split("/").at(-1) ?? href;
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").slice(0, 4) : "FILE";
  const target = href.startsWith("https://") ? null : fileTarget(href, workspace);

  return (
    <>
      <div className="cnv-file">
        <span className="cnv-file-icon">{extension.toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          {href.startsWith("https://") ? (
            <UrlLink href={href}>{name}</UrlLink>
          ) : target === null ? (
            <span>{name}</span>
          ) : (
            <FileLink target={target}>{name}</FileLink>
          )}
          <div className="cnv-muted" style={{ overflowWrap: "anywhere" }}>
            {href}
          </div>
        </div>
      </div>
      <Body body={node.body} />
    </>
  );
}

function DecisionContent({ node, actions }: { node: CanvasNode; actions: NodeActions }) {
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(option: string) {
    setSending(option);
    setError(null);

    try {
      await actions.choose(node, option);
      setSent(option);
    } catch {
      setError("Your choice could not be sent. Try again.");
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      <div style={{ fontWeight: 600 }}>{node.title}</div>
      {node.options.map((option) => (
        <button
          key={option}
          type="button"
          className="cnv-option"
          data-recommended={option === node.recommended}
          disabled={sending !== null || sent !== null}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void choose(option)}
        >
          <span>{sent === option ? `✓ ${option}` : option}</span>
          {option === node.recommended ? (
            <span className="cnv-option-note">Recommended</span>
          ) : null}
        </button>
      ))}
      {error === null ? null : (
        <div className="cnv-state" data-state="failed" role="alert" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <Body body={node.body} />
      </div>
    </>
  );
}

function StatusContent({ node }: { node: CanvasNode }) {
  return (
    <>
      {node.state === null ? null : (
        <div className="cnv-state" data-state={node.state} style={{ fontWeight: 600 }}>
          {stateLabels[node.state]}
          {node.progress === null ? "" : ` · ${Math.round(node.progress * 100)}%`}
        </div>
      )}
      {node.progress === null ? null : (
        <div
          className="cnv-progress"
          role="progressbar"
          aria-label={`${node.title ?? "Status"} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(node.progress * 100)}
        >
          <span style={{ width: `${node.progress * 100}%` }} />
        </div>
      )}
      <Body body={node.body} />
    </>
  );
}

function CodeContent({ body, language }: { body: string; language: string | null }) {
  const diff = language === "diff" || language === "patch";

  return (
    <pre className="cnv-code" onPointerDown={(event) => event.stopPropagation()}>
      {diff
        ? body.split("\n").map((row, index) => (
            <div
              key={index}
              className={
                row.startsWith("+") ? "cnv-diff-add" : row.startsWith("-") ? "cnv-diff-remove" : ""
              }
            >
              {row || " "}
            </div>
          ))
        : body}
    </pre>
  );
}
