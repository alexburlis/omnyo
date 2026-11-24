import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { OverflowFade, type OverflowFadeTone } from "./overflow-fade";

export default {
  title: "ui/Overflow fade",
};

const TONE_SURFACE_CLASS: Record<OverflowFadeTone, string> = {
  background: "bg-background",
  sidebar: "bg-sidebar",
  "surface-raised": "bg-surface-raised",
};

type FadeAnchor = "footer" | "header" | "none";

function FadeRows() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden p-2">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="h-6 shrink-0 rounded-sm border border-border-seam"
        />
      ))}
    </div>
  );
}

function PinnedBar({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 shrink-0 px-2 py-1.5">
      <div className="h-6 rounded-md border border-border bg-surface-recessed" />
      {children}
    </div>
  );
}

function FadeStage({
  anchor,
  children,
  tone,
}: {
  anchor: FadeAnchor;
  children: ReactNode;
  tone: OverflowFadeTone;
}) {
  return (
    <div
      className={`relative flex h-32 w-[320px] flex-col overflow-hidden rounded-md border border-border ${TONE_SURFACE_CLASS[tone]}`}
    >
      {anchor === "header" ? <PinnedBar>{children}</PinnedBar> : null}
      <FadeRows />
      {anchor === "footer" ? <PinnedBar>{children}</PinnedBar> : null}
      {anchor === "none" ? children : null}
    </div>
  );
}

export function Sizes() {
  return (
    <StoryCard labelWidth="150px">
      <StoryRow
        label="above — sm"
        hint="h-2 (8 px), used where a sticky label needs to separate from the rows under it"
      >
        <FadeStage anchor="footer" tone="background">
          <OverflowFade placement="above" tone="background" size="sm" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="above — default"
        hint="h-6 (24 px), the standard scroll edge above a pinned footer"
      >
        <FadeStage anchor="footer" tone="background">
          <OverflowFade placement="above" tone="background" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="above — lg"
        hint="h-24 (96 px). Added for the compact home, where rows scroll behind the pinned composer and need to dissolve rather than stop at a hard edge"
      >
        <FadeStage anchor="footer" tone="background">
          <OverflowFade placement="above" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="below — lg"
        hint="the same size cast downward from a pinned header"
      >
        <FadeStage anchor="header" tone="background">
          <OverflowFade placement="below" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow
        label="left / right — lg"
        hint="horizontal placements use w-24 at this size"
      >
        <FadeStage anchor="none" tone="background">
          <OverflowFade placement="left" tone="background" size="lg" />
          <OverflowFade placement="right" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Tones() {
  return (
    <StoryCard labelWidth="150px">
      <StoryRow label="background" hint="matches --background surfaces">
        <FadeStage anchor="footer" tone="background">
          <OverflowFade placement="above" tone="background" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="sidebar" hint="matches --sidebar surfaces">
        <FadeStage anchor="footer" tone="sidebar">
          <OverflowFade placement="above" tone="sidebar" size="lg" />
        </FadeStage>
      </StoryRow>
      <StoryRow label="surface-raised" hint="matches raised panel surfaces">
        <FadeStage anchor="footer" tone="surface-raised">
          <OverflowFade placement="above" tone="surface-raised" size="lg" />
        </FadeStage>
      </StoryRow>
    </StoryCard>
  );
}
