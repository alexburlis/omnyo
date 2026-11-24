export interface PlacementRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChatNoticeLayout {
  readonly shell: PlacementRect;
  readonly column: PlacementRect | null;
  readonly viewportTop: number | null;
  readonly cardWidth: number;
  readonly compact: boolean;
}

export interface ChatNoticePlacement {
  readonly mode: "docked" | "overlay";
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly visible: 1 | 2;
}

const DOCK_GUTTER = 20;

const OVERLAY_INSET = 16;

const COMPACT_INSET = 12;

const TOP_INSET = 12;

export function placeChatNotices({
  shell,
  column,
  viewportTop,
  cardWidth,
  compact,
}: ChatNoticeLayout): ChatNoticePlacement {
  const top = (viewportTop ?? shell.top) + TOP_INSET;

  if (
    !compact &&
    column !== null &&
    column.left - shell.left >= cardWidth + 2 * DOCK_GUTTER
  )
    return {
      mode: "docked",
      left: shell.left + DOCK_GUTTER,
      top,
      width: cardWidth,
      visible: 2,
    };

  const inset = compact ? COMPACT_INSET : OVERLAY_INSET;
  const width = Math.max(0, Math.min(cardWidth, shell.width - 2 * inset));

  return {
    mode: "overlay",
    left: compact ? shell.left + (shell.width - width) / 2 : shell.left + inset,
    top,
    width,
    visible: 1,
  };
}
