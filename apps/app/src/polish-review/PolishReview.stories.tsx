import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  POLISH_AREAS,
  POLISH_BEFORE_SNAPSHOT,
  POLISH_CHANGES,
  POLISH_KINDS,
  POLISH_KIND_LABEL,
  POLISH_VISIBILITY_LABEL,
  type PolishChange,
  type PolishKind,
  type PolishVisibility,
} from "./polish-review-manifest";

export default {
  title: "Polish review",
};

type Mode = "compare" | "read";

type Layout = "side" | "stacked" | "flip";

type FrameTheme = "dark" | "light";

type FrameWidth = "desktop" | "fill" | "phone";

type ServerStatus = "checking" | "online" | "offline";

type FlipSide = "before" | "after";

const SPEEDS = [1, 0.5, 0.25, 0.1] as const;

type Speed = (typeof SPEEDS)[number];

const SPEED_LABEL: Record<Speed, string> = {
  1: "1×",
  0.5: "½×",
  0.25: "¼×",
  0.1: "⅒×",
};

const KIND_DOT: Record<PolishKind, string> = {
  animation: "bg-timeline-accent",
  interaction: "bg-file-accent",
  state: "bg-warning",
  visual: "bg-pr-merged",
  fix: "bg-destructive",
  story: "bg-success",
  ux: "bg-attention",
};

const SHOT_URLS = import.meta.glob<string>("../../.ladle/polish-shots/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

function shotUrl(name: string | null): string | null {
  if (name === null) return null;

  return SHOT_URLS[`../../.ladle/polish-shots/${name}`] ?? null;
}

const VISIBILITY_ORDER: readonly PolishVisibility[] = [
  "obvious",
  "noticeable",
  "subtle",
];

type PassFilter = "all" | 2;

const PLAYBACK_MESSAGE = "omnyo-ladle-playback-rate";

const DESKTOP_FRAME_WIDTH = 960;

const CONTROL = cn(
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function areaName(key: string): string {
  return POLISH_AREAS.find((area) => area.key === key)?.name ?? key;
}

function areaOrder(key: string): number {
  const index = POLISH_AREAS.findIndex((area) => area.key === key);

  return index < 0 ? POLISH_AREAS.length : index;
}

function storyUrl(origin: string, storyId: string, theme: FrameTheme) {
  return `${origin}/?story=${encodeURIComponent(storyId)}&mode=preview&theme=${theme}`;
}

function readHashChange(): string | null {
  const match = /change=([^&]+)/.exec(window.location.hash);

  return match ? decodeURIComponent(match[1]) : null;
}

function useBeforeServerStatus(origin: string): [ServerStatus, () => void] {
  const [status, setStatus] = useState<ServerStatus>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;

    setStatus("checking");
    fetch(`${origin}/meta.json?attempt=${attempt}`, {
      mode: "no-cors",
      signal: controller.signal,
    })
      .then(() => {
        if (active) setStatus("online");
      })
      .catch(() => {
        if (active) setStatus("offline");
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, origin]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return [status, retry];
}

function useSameOriginPlaybackRate(
  frame: RefObject<HTMLIFrameElement | null>,
  rate: Speed,
  reloadKey: string,
) {
  useEffect(() => {
    const apply = () => {
      const animations = frame.current?.contentDocument?.getAnimations() ?? [];

      for (const animation of animations) {
        if (animation.playbackRate !== rate) animation.playbackRate = rate;
      }
    };

    apply();

    if (rate === 1) return;

    let handle = requestAnimationFrame(function tick() {
      apply();
      handle = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(handle);
  }, [frame, rate, reloadKey]);
}

function postPlaybackRate(
  frame: HTMLIFrameElement | null,
  origin: string,
  rate: Speed,
) {
  frame?.contentWindow?.postMessage({ type: PLAYBACK_MESSAGE, rate }, origin);
}

function Segmented<Value extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: Value; label: string; hint?: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="relative grid h-7 rounded-md bg-surface-recessed p-0.5"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-sm bg-surface-raised-solid shadow-xs ring-1 ring-border-hairline transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={cn(
            CONTROL_HOVER_TRANSITION,
            "relative z-10 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring",
            option.value === value
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChangeNote({ note }: { note: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-border-hairline bg-surface-attention px-2.5 py-1.5 text-xs text-foreground">
      <Icon
        name="AlertTriangle"
        className="mt-0.5 size-3.5 shrink-0 text-warning-text"
      />
      {note}
    </p>
  );
}

function VisibilityLabel({
  visibility,
}: {
  visibility: PolishVisibility | null;
}) {
  if (visibility === null) return null;

  return (
    <span
      className={cn(
        "rounded-sm px-1 text-2xs font-medium",
        visibility === "obvious"
          ? "bg-surface-selected text-foreground"
          : "text-subtle-foreground",
      )}
    >
      {POLISH_VISIBILITY_LABEL[visibility]}
    </span>
  );
}

function ShotFrame({
  side,
  src,
  hidden,
}: {
  side: FlipSide;
  src: string | null;
  hidden?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background",
        hidden && "invisible",
      )}
    >
      <div className="flex h-8 shrink-0 items-center border-b border-border-hairline bg-surface-recessed px-3">
        <span className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span
            className={cn(
              "size-1.5 rounded-full",
              side === "before" ? "bg-subtle-foreground" : "bg-success",
            )}
          />
          {side === "before" ? "Before · screenshot" : "After · screenshot"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background p-3">
        {src ? (
          <img
            src={src}
            alt={`${side} screenshot`}
            className="mx-auto max-w-full rounded-md border border-border-hairline"
          />
        ) : (
          <FramePlaceholder title="Screenshot not available here">
            This surface is outside Ladle; its screenshots live only in the
            polish worktree.
          </FramePlaceholder>
        )}
      </div>
    </div>
  );
}

function KindLabel({ kind }: { kind: PolishKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", KIND_DOT[kind])} />
      {POLISH_KIND_LABEL[kind]}
    </span>
  );
}

function StatusPill({ status }: { status: ServerStatus }) {
  const tone =
    status === "online"
      ? "bg-success"
      : status === "offline"
        ? "bg-destructive"
        : "bg-subtle-foreground";

  const text =
    status === "online"
      ? "Before server online"
      : status === "offline"
        ? "Before server offline"
        : "Checking before server";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-hairline px-2 py-0.5 text-2xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", tone)} />
      {text}
    </span>
  );
}

function FramePlaceholder({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="max-w-md text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;

    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function StoryFrame({
  side,
  src,
  frameRef,
  width,
  hidden,
  onLoad,
  placeholder,
}: {
  side: FlipSide;
  src: string | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  width: FrameWidth;
  hidden?: boolean;
  onLoad?: () => void;
  placeholder: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewport = useElementSize(viewportRef);

  const desktopScale =
    viewport.width > 0 && viewport.width < DESKTOP_FRAME_WIDTH
      ? viewport.width / DESKTOP_FRAME_WIDTH
      : 1;

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background",
        hidden && "invisible",
      )}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border-hairline bg-surface-recessed px-3">
        <span className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span
            className={cn(
              "size-1.5 rounded-full",
              side === "before" ? "bg-subtle-foreground" : "bg-success",
            )}
          />
          {side === "before" ? "Before · snapshot" : "After · live"}
        </span>
        {src ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cn(
              CONTROL_HOVER_TRANSITION,
              "text-2xs text-subtle-foreground hover:text-foreground",
            )}
          >
            Open in new tab
          </a>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className="relative flex min-h-0 flex-1 justify-center overflow-hidden bg-background"
      >
        {src ? (
          <iframe
            ref={frameRef}
            title={`${side} story`}
            src={src}
            onLoad={onLoad}
            className={cn(
              "border-0 bg-background",
              width === "phone" &&
                "h-full w-[390px] border-x border-border-hairline",
              width === "fill" && "h-full w-full",
              width === "desktop" &&
                (desktopScale === 1
                  ? "h-full w-full"
                  : "absolute top-0 left-0 origin-top-left"),
            )}
            style={
              width === "desktop" && desktopScale !== 1
                ? {
                    width: DESKTOP_FRAME_WIDTH,
                    height: viewport.height / desktopScale,
                    transform: `scale(${desktopScale})`,
                  }
                : undefined
            }
          />
        ) : (
          placeholder
        )}
      </div>
    </div>
  );
}

interface CompareSettings {
  layout: Layout;
  theme: FrameTheme;
  width: FrameWidth;
  speed: Speed;
  flipSide: FlipSide;
}

const DEFAULT_SETTINGS: CompareSettings = {
  layout: "side",
  theme: "dark",
  width: "desktop",
  speed: 1,
  flipSide: "after",
};

function CompareStage({
  change,
  position,
  total,
  beforeOrigin,
  beforeStatus,
  onRetryBefore,
  settings,
  onSettings,
  onStep,
}: {
  change: PolishChange;
  position: number;
  total: number;
  beforeOrigin: string;
  beforeStatus: ServerStatus;
  onRetryBefore: () => void;
  settings: CompareSettings;
  onSettings: (patch: Partial<CompareSettings>) => void;
  onStep: (delta: number) => void;
}) {
  const { layout, theme, width, speed, flipSide } = settings;
  const [replay, setReplay] = useState(0);
  const beforeFrame = useRef<HTMLIFrameElement | null>(null);
  const afterFrame = useRef<HTMLIFrameElement | null>(null);
  const reloadKey = `${change.id}:${theme}:${replay}`;

  useSameOriginPlaybackRate(afterFrame, speed, reloadKey);

  useEffect(() => {
    postPlaybackRate(beforeFrame.current, beforeOrigin, speed);
  }, [beforeOrigin, speed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key === "r") setReplay((value) => value + 1);

      if (event.key === "f") {
        onSettings({
          layout: "flip",
          flipSide:
            layout === "flip" && flipSide === "after" ? "before" : "after",
        });
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [flipSide, layout, onSettings]);

  const beforeSrc =
    change.beforeStoryId && beforeStatus === "online"
      ? storyUrl(beforeOrigin, change.beforeStoryId, theme)
      : null;

  const afterSrc =
    change.storyId === null ? null : storyUrl("", change.storyId, theme);

  const beforePlaceholder = !change.beforeStoryId ? (
    <FramePlaceholder title="New in this pass">
      This story did not exist before the polish pass, so there is no before
      state to show.
    </FramePlaceholder>
  ) : beforeStatus === "checking" ? (
    <FramePlaceholder title="Connecting to the before snapshot">
      {beforeOrigin}
    </FramePlaceholder>
  ) : (
    <FramePlaceholder title="The before snapshot server is not running">
      <span className="block">
        Start “Ladle before snapshot” from the Dev servers shelf, or run pnpm
        --dir {POLISH_BEFORE_SNAPSHOT.worktree}/apps/app exec ladle serve --port{" "}
        {POLISH_BEFORE_SNAPSHOT.port}
      </span>
      <button
        type="button"
        className={cn(CONTROL, "mt-3")}
        onClick={onRetryBefore}
      >
        <Icon name="RotateCcw" className="size-3.5" />
        Check again
      </button>
    </FramePlaceholder>
  );

  const usesShots =
    change.storyId === null &&
    (change.beforeShot !== null || change.afterShot !== null);

  const beforeNode = usesShots ? (
    <ShotFrame
      side="before"
      src={shotUrl(change.beforeShot)}
      hidden={layout === "flip" && flipSide !== "before"}
    />
  ) : (
    <StoryFrame
      key={`before:${reloadKey}`}
      side="before"
      src={beforeSrc}
      frameRef={beforeFrame}
      width={width}
      hidden={layout === "flip" && flipSide !== "before"}
      onLoad={() => postPlaybackRate(beforeFrame.current, beforeOrigin, speed)}
      placeholder={beforePlaceholder}
    />
  );

  const afterNode = usesShots ? (
    <ShotFrame
      side="after"
      src={shotUrl(change.afterShot)}
      hidden={layout === "flip" && flipSide !== "after"}
    />
  ) : (
    <StoryFrame
      key={`after:${reloadKey}`}
      side="after"
      src={afterSrc}
      frameRef={afterFrame}
      width={width}
      hidden={layout === "flip" && flipSide !== "after"}
      placeholder={
        <FramePlaceholder title="No story renders this state">
          {change.howToSee}
        </FramePlaceholder>
      }
    />
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 space-y-3 border-b border-border px-6 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span className="text-2xs font-medium text-subtle-foreground">
            {areaName(change.area)}
          </span>
          <KindLabel kind={change.kind} />
          <VisibilityLabel visibility={change.visibility} />
          <span className="ml-auto text-2xs text-subtle-foreground tabular-nums">
            {position} of {total}
          </span>
        </div>
        <h2 className="text-lead font-semibold text-balance text-foreground">
          {change.title}
        </h2>
        {change.note === null ? null : <ChangeNote note={change.note} />}
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-1">
            <span className="text-2xs font-semibold tracking-wide text-subtle-foreground uppercase">
              Before
            </span>
            <p className="text-sm text-pretty text-muted-foreground">
              {change.before}
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-2xs font-semibold tracking-wide text-subtle-foreground uppercase">
              After
            </span>
            <p className="text-sm text-pretty text-foreground">
              {change.after}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-1 text-xs">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-muted-foreground">
            <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">How to see: </span>
              {change.howToSee}
            </span>
          </p>
          <p className="min-w-0 flex-1 text-subtle-foreground">
            <span className="font-medium text-muted-foreground">Why: </span>
            {change.why}
          </p>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-hairline px-6 py-2">
        <button
          type="button"
          className={CONTROL}
          onClick={() => setReplay((value) => value + 1)}
          title="Reload both frames (R)"
        >
          <Icon name="RotateCcw" className="size-3.5" />
          Replay
        </button>
        <Segmented
          label="Playback speed"
          value={speed}
          onChange={(value) => onSettings({ speed: value })}
          options={SPEEDS.map((value) => ({
            value,
            label: SPEED_LABEL[value],
            hint: `Play CSS and Web Animations at ${SPEED_LABEL[value]}`,
          }))}
        />
        <Segmented
          label="Layout"
          value={layout}
          onChange={(value) => onSettings({ layout: value })}
          options={[
            { value: "side", label: "Side by side" },
            { value: "stacked", label: "Stacked" },
            { value: "flip", label: "Flip", hint: "Press F to flip" },
          ]}
        />
        {layout === "flip" ? (
          <Segmented
            label="Visible side"
            value={flipSide}
            onChange={(value) => onSettings({ flipSide: value })}
            options={[
              { value: "before", label: "Before" },
              { value: "after", label: "After" },
            ]}
          />
        ) : null}
        <Segmented
          label="Theme"
          value={theme}
          onChange={(value) => onSettings({ theme: value })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
        <Segmented
          label="Frame width"
          value={width}
          onChange={(value) => onSettings({ width: value })}
          options={[
            {
              value: "desktop",
              label: "Desktop",
              hint: `Render at ${DESKTOP_FRAME_WIDTH} px and scale to fit`,
            },
            { value: "fill", label: "Fill" },
            { value: "phone", label: "Phone" },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={CONTROL}
            onClick={() => onStep(-1)}
            title="Previous change (K or ↑)"
          >
            <Icon name="ChevronLeft" className="size-3.5" />
            Previous
          </button>
          <button
            type="button"
            className={CONTROL}
            onClick={() => onStep(1)}
            title="Next change (J or ↓)"
          >
            Next
            <Icon name="ChevronRight" className="size-3.5" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-3 p-4",
          layout === "side" && "grid-cols-2",
          layout === "stacked" && "grid-rows-2",
          layout === "flip" &&
            "grid-cols-1 grid-rows-1 *:col-start-1 *:row-start-1",
        )}
      >
        {beforeNode}
        {afterNode}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-hairline px-6 py-2 text-2xs text-subtle-foreground">
        <span className="font-mono">{change.files.join("  ·  ")}</span>
        <span className="ml-auto">
          J/K or ↑/↓ step · R replay · F flip · slow motion affects CSS and Web
          Animations only
        </span>
      </footer>
    </section>
  );
}

function ReadAll({
  changes,
  onCompare,
}: {
  changes: readonly PolishChange[];
  onCompare: (id: string) => void;
}) {
  const groups = useMemo(() => groupByArea(changes), [changes]);

  return (
    <section className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-10 px-8 py-8">
        {groups.map(([area, items]) => (
          <div key={area} className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              {areaName(area)}
              <span className="ml-2 font-normal text-subtle-foreground tabular-nums">
                {items.length}
              </span>
            </h2>
            <div className="divide-y divide-border-hairline overflow-hidden rounded-lg border border-border bg-card">
              {items.map((change) => (
                <article key={change.id} className="space-y-2 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {change.title}
                    </h3>
                    <KindLabel kind={change.kind} />
                    <VisibilityLabel visibility={change.visibility} />
                    <button
                      type="button"
                      className={cn(CONTROL, "-my-1")}
                      onClick={() => onCompare(change.id)}
                    >
                      Compare
                      <Icon name="ChevronRight" className="size-3.5" />
                    </button>
                  </div>
                  {change.note === null ? null : (
                    <ChangeNote note={change.note} />
                  )}
                  <div className="grid grid-cols-2 gap-6 text-xs">
                    <p className="text-muted-foreground">
                      <span className="font-medium text-subtle-foreground">
                        Before:{" "}
                      </span>
                      {change.before}
                    </p>
                    <p className="text-foreground">
                      <span className="font-medium text-subtle-foreground">
                        After:{" "}
                      </span>
                      {change.after}
                    </p>
                  </div>
                  <p className="text-2xs text-subtle-foreground">
                    {change.howToSee}
                    {change.storyId === null ? null : (
                      <>
                        <span className="mx-1.5">·</span>
                        <span className="font-mono">{change.storyId}</span>
                      </>
                    )}
                  </p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function groupByArea(
  changes: readonly PolishChange[],
): [string, PolishChange[]][] {
  const groups = new Map<string, PolishChange[]>();

  for (const change of changes) {
    const list = groups.get(change.area) ?? [];

    list.push(change);
    groups.set(change.area, list);
  }

  return [...groups.entries()].sort(
    ([left], [right]) => areaOrder(left) - areaOrder(right),
  );
}

export const BeforeAndAfter = () => {
  const beforeOrigin = useMemo(
    () =>
      `${window.location.protocol}//${window.location.hostname}:${POLISH_BEFORE_SNAPSHOT.port}`,
    [],
  );

  const [beforeStatus, retryBefore] = useBeforeServerStatus(beforeOrigin);
  const [mode, setMode] = useState<Mode>("compare");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PolishKind | "all">("all");

  const [visibility, setVisibility] = useState<PolishVisibility | "all">("all");

  const [pass, setPass] = useState<PassFilter>("all");

  const [selectedId, setSelectedId] = useState<string | null>(
    () => readHashChange() ?? POLISH_CHANGES[0]?.id ?? null,
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  const [settings, setSettings] = useState<CompareSettings>(DEFAULT_SETTINGS);

  const patchSettings = useCallback(
    (patch: Partial<CompareSettings>) =>
      setSettings((current) => ({ ...current, ...patch })),
    [],
  );

  const ordered = useMemo(
    () => groupByArea(POLISH_CHANGES).flatMap(([, items]) => items),
    [],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return ordered.filter(
      (change) =>
        (kind === "all" || change.kind === kind) &&
        (visibility === "all" || change.visibility === visibility) &&
        (pass === "all" || change.pass === pass) &&
        (needle === "" ||
          [
            change.title,
            change.before,
            change.after,
            change.storyId ?? "",
            change.area,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [kind, ordered, pass, query, visibility]);

  const groups = useMemo(() => groupByArea(filtered), [filtered]);

  const selected =
    filtered.find((change) => change.id === selectedId) ?? filtered[0] ?? null;

  const position = selected ? filtered.indexOf(selected) + 1 : 0;

  const select = useCallback((id: string) => {
    setSelectedId(id);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#change=${encodeURIComponent(id)}`,
    );
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return;
      const index = selected ? filtered.indexOf(selected) : -1;

      const next =
        filtered[(index + delta + filtered.length) % filtered.length];

      select(next.id);
    },
    [filtered, select, selected],
  );

  useEffect(() => {
    if (!selected) return;
    listRef.current
      ?.querySelector(`[data-change-id="${CSS.escape(selected.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        step(1);
      }

      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        step(-1);
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const kindCounts = useMemo(() => {
    const counts = new Map<PolishKind, number>();

    for (const change of POLISH_CHANGES) {
      counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
    }

    return counts;
  }, []);

  const areaCount = new Set(POLISH_CHANGES.map((change) => change.area)).size;

  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <aside className="flex w-[22rem] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="space-y-3 border-b border-border px-4 pt-5 pb-4">
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-foreground">
              Polish review
            </h1>
            <p className="text-xs text-muted-foreground">
              {plural(POLISH_CHANGES.length, "change")} across{" "}
              {plural(areaCount, "area")}. Before is snapshot{" "}
              {POLISH_BEFORE_SNAPSHOT.commit}; after is the live checkout.
            </p>
          </div>
          <StatusPill status={beforeStatus} />
          <Segmented
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { value: "compare", label: "Compare" },
              { value: "read", label: "Read all" },
            ]}
          />
          <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:outline-2 focus-within:outline-ring">
            <Icon name="Search" className="size-3.5 text-subtle-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter changes"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </label>
          <div className="space-y-2">
            <Segmented
              label="Pass"
              value={pass}
              onChange={setPass}
              options={[
                { value: "all", label: "Both passes" },
                { value: 2, label: "Pass 2" },
              ]}
            />
            <Segmented
              label="Visibility"
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "all", label: "Any" },
                ...VISIBILITY_ORDER.map((value) => ({
                  value,
                  label: POLISH_VISIBILITY_LABEL[value],
                })),
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(["all", ...POLISH_KINDS] as const).map((value) => {
              const count =
                value === "all"
                  ? POLISH_CHANGES.length
                  : (kindCounts.get(value) ?? 0);

              if (count === 0) return null;

              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  aria-pressed={kind === value}
                  className={cn(
                    CONTROL_PRESS_TRANSITION,
                    CONTROL_PRESS_FEEDBACK,
                    "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-2xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                    kind === value
                      ? "border-surface-selected-border bg-surface-selected text-foreground"
                      : "border-border-hairline text-muted-foreground hover:bg-state-hover hover:text-foreground",
                  )}
                >
                  {value === "all" ? null : (
                    <span
                      className={cn("size-1.5 rounded-full", KIND_DOT[value])}
                    />
                  )}
                  {value === "all" ? "All" : POLISH_KIND_LABEL[value]}
                  <span className="text-subtle-foreground tabular-nums">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-6">
          {groups.length === 0 ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">
              {POLISH_CHANGES.length === 0
                ? "No changes are recorded yet."
                : "No changes match this filter."}
            </p>
          ) : null}
          {groups.map(([area, items]) => (
            <div key={area}>
              <div className="sticky top-0 z-10 flex items-baseline justify-between border-b border-border-hairline bg-sidebar px-4 pt-4 pb-1.5">
                <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {areaName(area)}
                </span>
                <span className="text-2xs text-subtle-foreground tabular-nums">
                  {items.length}
                </span>
              </div>
              <ul className="px-2 pt-1">
                {items.map((change) => {
                  const active =
                    mode === "compare" && change.id === selected?.id;

                  return (
                    <li key={change.id}>
                      <button
                        type="button"
                        data-change-id={change.id}
                        onClick={() => {
                          select(change.id);
                          setMode("compare");
                        }}
                        className={cn(
                          "flex w-full flex-col items-start gap-1 rounded-md px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-state-hover",
                        )}
                      >
                        <span className="line-clamp-2 text-xs font-medium">
                          {change.title}
                        </span>
                        <KindLabel kind={change.kind} />
                        <VisibilityLabel visibility={change.visibility} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </aside>
      {mode === "read" ? (
        <ReadAll
          changes={filtered}
          onCompare={(id) => {
            select(id);
            setMode("compare");
          }}
        />
      ) : selected ? (
        <CompareStage
          key={selected.id}
          change={selected}
          position={position}
          total={filtered.length}
          beforeOrigin={beforeOrigin}
          beforeStatus={beforeStatus}
          onRetryBefore={retryBefore}
          settings={settings}
          onSettings={patchSettings}
          onStep={step}
        />
      ) : (
        <section className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a change to compare.
        </section>
      )}
    </div>
  );
};

BeforeAndAfter.storyName = "Before and after";
