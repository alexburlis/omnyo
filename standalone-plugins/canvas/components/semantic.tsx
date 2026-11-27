import type { ReactNode } from "react";
import type { IslandAccent, NodeViews } from "../contract";
import type { SemanticDetail } from "../lib/semantic";
import { useSemanticDetail } from "./semantic-detail";
import { HtmlFrame } from "./html-frame";

interface SemanticProps {
  title: string;
  accent?: IslandAccent;
  views?: NodeViews | null;
  zoom: number;
  compact: boolean;
  canvasNavigation: boolean;
  data?: string | null;
  onHeight?(): void;
  onDocument?(): void;
}

export function SemanticHtml({ html, ...props }: SemanticProps & { html: string }) {
  const detail = useSemanticDetail(props.zoom, props.compact);
  const evidence = props.views?.evidence ?? html;

  const renderEvidence = (active: boolean) => (
    <HtmlFrame
      active={active}
      html={evidence}
      title={props.title}
      accent={props.accent}
      canvasNavigation={props.canvasNavigation && !props.compact}
      onHeight={props.onHeight}
      onDocument={props.onDocument}
    />
  );

  if (props.views?.overview === undefined && props.views?.sources === undefined)
    return renderEvidence(true);

  return (
    <SemanticLayers
      {...props}
      detail={detail}
      canvasNavigation={props.canvasNavigation && !props.compact}
    >
      {renderEvidence}
    </SemanticLayers>
  );
}

export function SemanticLayers({
  title,
  accent,
  views,
  detail,
  compact,
  canvasNavigation,
  data,
  onHeight,
  onDocument,
  children,
}: Omit<SemanticProps, "zoom"> & { detail: SemanticDetail; children(active: boolean): ReactNode }) {
  const overview = views?.overview;
  const sources = views?.sources;
  const showOverview = detail === "overview" && overview !== undefined;
  const showSources = !showOverview && (detail === "sources" || compact);
  const navigation = canvasNavigation;

  return (
    <div className="cnv-semantic" data-detail={showOverview ? "overview" : detail}>
      {overview === undefined ? null : (
        <div
          className="cnv-semantic-layer"
          data-view="overview"
          data-active={showOverview}
          aria-hidden={!showOverview}
          inert={!showOverview}
        >
          <HtmlFrame
            html={overview}
            active={showOverview}
            title={`${title} · Overview`}
            accent={accent}
            canvasNavigation={navigation}
            data={data}
            onHeight={onHeight}
            onDocument={onDocument}
          />
        </div>
      )}
      <div
        className="cnv-semantic-layer"
        data-view="evidence"
        data-active={!showOverview}
        aria-hidden={showOverview}
        inert={showOverview}
      >
        {children(!showOverview)}
        {sources === undefined ? null : (
          <div
            className="cnv-semantic-sources"
            data-view="sources"
            data-active={showSources}
            aria-hidden={!showSources}
            inert={!showSources}
          >
            <HtmlFrame
              html={sources}
              active={showSources}
              title={`${title} · Sources`}
              accent={accent}
              canvasNavigation={navigation}
              data={data}
              onHeight={onHeight}
              onDocument={onDocument}
            />
          </div>
        )}
      </div>
    </div>
  );
}
