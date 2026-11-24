import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from "react";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@/components/ui/motion";
import {
  experimental_ThreadAttention as ThreadAttention,
  experimental_useSidebarThreads,
  ThreadTitle,
  experimental_useAppNavigate,
  useSdk,
  type experimental_PluginBrowserSdk,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import {
  asksNativeQuestion,
  COUNTDOWN_MS,
  countdownElapsed,
  hiddenChatNoticeCount,
  isDrawnChatNotice,
  liveChatNotice,
  nextChatNoticeDeadline,
  quickAnswers,
  SENT_DWELL_MS,
  shownChatNotices,
  type ChatNoticeAction,
  type ChatNoticeHold,
  type ChatNoticeStack,
  type ChatNoticeTone,
  type Countdown,
  type LiveChatNotice,
  type NativeQuestion,
  type NativeQuestionOption,
  type ShownChatNotice,
  type ShownChatNoticePhase,
} from "./chat-notice-model.js";
import { openNativeQuestion } from "./native-question.js";
import {
  placeChatNotices,
  type ChatNoticeLayout,
  type ChatNoticePlacement,
  type PlacementRect,
} from "./chat-notice-placement.js";

type Send = (action: ChatNoticeAction) => void;

type ContinuationState = Awaited<
  ReturnType<
    experimental_PluginBrowserSdk["threads"]["experimental_continuationState"]
  >
>;

type Remote<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed" };

type NoticeContent =
  | { readonly tone: "needs-you"; readonly question: NativeQuestion | null }
  | { readonly tone: "failed"; readonly continuation: ContinuationState };

const DRAW_WAIT_MS = 1_500;

const CARD_WIDTH = 312;

const COMPACT_MAX_WIDTH = 767;

const RING_LENGTH = 2 * Math.PI * 10;

const CLOCK_MS = 30_000;

const INITIAL_PLACEMENT: ChatNoticePlacement = {
  mode: "overlay",
  left: 0,
  top: 0,
  width: CARD_WIDTH,
  visible: 1,
};

const TONES = {
  "needs-you": {
    label: "Needs you",
    word: "text-[color-mix(in_oklch,var(--attention)_72%,var(--foreground))]",
    tile: "bg-attention/17 text-attention",
    ring: "stroke-attention",
    glow: "bg-[radial-gradient(130%_70%_at_0%_0%,color-mix(in_oklab,var(--attention)_15%,transparent),transparent_62%)]",
    edge: "bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--attention)_70%,transparent)_30%,transparent)]",
    Glyph: QuestionGlyph,
  },
  failed: {
    label: "Failed",
    word: "text-destructive-text",
    tile: "bg-destructive/17 text-destructive",
    ring: "stroke-destructive",
    glow: "bg-[radial-gradient(130%_70%_at_0%_0%,color-mix(in_oklab,var(--destructive)_15%,transparent),transparent_62%)]",
    edge: "bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--destructive)_70%,transparent)_30%,transparent)]",
    Glyph: AlertGlyph,
  },
} satisfies Record<
  ChatNoticeTone,
  {
    label: string;
    word: string;
    tile: string;
    ring: string;
    glow: string;
    edge: string;
    Glyph: () => ReactNode;
  }
>;

const MOTION = {
  card: "animate-in fade-in slide-in-from-left-6 zoom-in-97 duration-(--motion-duration-slow) ease-(--motion-ease-smooth)",
  sending:
    "animate-in fade-in slide-in-from-left-6 zoom-in-97 duration-(--motion-duration-slow) ease-(--motion-ease-smooth)",
  sent: "animate-out fade-out slide-out-to-top-2 zoom-out-97 [--tw-animation-delay:var(--chat-notice-sent-dwell)] duration-(--motion-duration-base) ease-(--motion-ease-in) fill-mode-forwards",
  leaving:
    "pointer-events-none animate-out fade-out slide-out-to-left-6 zoom-out-97 duration-(--motion-duration-base) ease-(--motion-ease-in) fill-mode-forwards",
} satisfies Record<ShownChatNoticePhase["kind"], string>;

const NOTICE_STYLE = {
  "--chat-notice-sent-dwell": `${SENT_DWELL_MS}ms`,
} as CSSProperties;

const CHOICE = `pointer-events-auto h-7 rounded-[9px] border border-foreground/14 bg-foreground/4 px-[11px] text-xs font-semibold text-foreground hover:bg-foreground/10 disabled:opacity-50 ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`;

const PRIMARY_CHOICE = `pointer-events-auto h-7 rounded-[9px] border border-transparent bg-foreground px-[11px] text-xs font-semibold text-background hover:bg-foreground/86 disabled:opacity-50 ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`;

export function ChatNotices({
  stack,
  send,
  openThreadId,
}: {
  stack: ChatNoticeStack;
  send: Send;
  openThreadId: string | null;
}) {
  const sidebar = experimental_useSidebarThreads();
  const shown = shownChatNotices(stack);
  const placement = useChatNoticePlacement(shown.length > 0, openThreadId);
  const now = useClock(shown.length > 0);

  const live =
    sidebar.status === "ready"
      ? new Map<string, LiveChatNotice>(
          stack.entries.map((entry) => [
            entry.notice.threadId,
            liveChatNotice(sidebar, entry.notice.threadId),
          ]),
        )
      : null;

  useLayoutEffect(() => {
    send({
      type: "sync",
      context: {
        live,
        openThreadId,
        capacity: placement.visible,
        countdown: placement.mode === "overlay",
      },
    });
  });

  useEffect(() => {
    const due = nextChatNoticeDeadline(stack);

    if (due === null) return;

    const timer = window.setTimeout(
      () => send({ type: "tick" }),
      Math.max(0, due - Date.now()),
    );

    return () => window.clearTimeout(timer);
  }, [stack, send]);

  if (shown.length === 0) return null;
  const hidden = hiddenChatNoticeCount(stack);

  return (
    <section
      aria-label="Chat notifications"
      aria-live="polite"
      data-chat-notices={placement.mode}
      className="pointer-events-none fixed z-30 flex flex-col gap-2.5"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
      }}
    >
      {shown.map((entry) => {
        const thread =
          sidebar.threads.find(({ id }) => id === entry.notice.threadId) ??
          null;

        return (
          <ChatNoticeCard
            key={entry.notice.threadId}
            entry={entry}
            thread={thread}
            projectName={
              sidebar.projects.find(({ id }) => id === thread?.projectId)
                ?.name ?? null
            }
            now={now}
            send={send}
          />
        );
      })}
      {hidden > 0 && shown.every(isDrawnChatNotice) ? (
        <button
          type="button"
          onClick={() => send({ type: "cycle" })}
          className={`pointer-events-auto animate-in self-start rounded-full border border-foreground/10 bg-popover/92 px-2.5 py-1 text-xs font-semibold text-popover-foreground shadow-[0_6px_16px_-8px_var(--shadow-color)] backdrop-blur-[18px] fade-in-0 ${CONTROL_HOVER_TRANSITION} hover:bg-popover`}
        >
          +{hidden} more waiting
        </button>
      ) : null}
    </section>
  );
}

function ChatNoticeCard({
  entry,
  thread,
  projectName,
  now,
  send,
}: {
  entry: ShownChatNotice;
  thread: PluginSidebarThread | null;
  projectName: string | null;
  now: number;
  send: Send;
}) {
  const navigate = experimental_useAppNavigate();
  const { notice, phase } = entry;
  const drawn = isDrawnChatNotice(entry);

  const [asked, setAsked] = useState(() => ({
    noticeId: notice.id,
    question: asksNativeQuestion(thread),
  }));

  if (asked.noticeId !== notice.id)
    setAsked({ noticeId: notice.id, question: asksNativeQuestion(thread) });

  const content = useThreadRead(
    phase.tone !== "needs-you"
      ? readContinuation
      : asked.question
        ? readOpenQuestion
        : readNoQuestion,
    notice.threadId,
    `${phase.tone}:${notice.id}`,
  );

  const settled = content.status !== "loading";

  useEffect(() => {
    if (drawn) return;

    const draw = () =>
      send({
        type: "hold",
        noticeId: notice.id,
        source: "loading",
        held: false,
      });

    if (settled) {
      draw();

      return;
    }

    const timer = window.setTimeout(draw, DRAW_WAIT_MS);

    return () => window.clearTimeout(timer);
  }, [drawn, settled, notice.id, send]);

  if (!drawn) return null;
  const tone = TONES[phase.tone];
  const countdown = phase.kind === "card" ? phase.countdown : null;
  const loaded = content.status === "ready" ? content.value : null;

  const hold = (source: ChatNoticeHold, held: boolean) =>
    send({ type: "hold", noticeId: notice.id, source, held });

  const dismiss = () => send({ type: "dismiss", noticeId: notice.id });

  const open = () => {
    send({ type: "open", noticeId: notice.id });
    navigate.toThread(notice.threadId, { experimental_userInitiated: true });
  };

  return (
    <article
      aria-label={thread?.displayTitle ?? notice.title}
      onPointerEnter={() => hold("pointer", true)}
      onPointerLeave={() => hold("pointer", false)}
      onFocus={() => hold("focus", true)}
      onBlur={(event) => {
        if (!keepsFocus(event)) hold("focus", false);
      }}
      style={NOTICE_STYLE}
      className={`group/notice pointer-events-auto relative overflow-hidden rounded-[14px] border border-foreground/10 bg-popover/92 px-3 pb-2.5 pt-3 text-popover-foreground shadow-[0_14px_34px_-10px_var(--shadow-color),0_3px_8px_-2px_var(--shadow-color)] backdrop-blur-[18px] backdrop-saturate-[1.4] ${MOTION[phase.kind]}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 ${tone.glow}`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-3.5 top-0 h-px ${tone.edge}`}
      />
      <button
        type="button"
        aria-label={`Open chat: ${thread?.displayTitle ?? notice.title}`}
        disabled={phase.kind === "leaving"}
        onClick={open}
        className={`absolute inset-0 cursor-pointer rounded-[inherit] ${CONTROL_HOVER_TRANSITION} hover:bg-foreground/3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
      />
      <div className="pointer-events-none relative flex items-start gap-2.5">
        <span
          aria-hidden
          className={`grid size-[26px] shrink-0 place-items-center rounded-[9px] ${tone.tile}`}
        >
          <tone.Glyph />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-snug">
            {thread === null ? (
              notice.title
            ) : (
              <ThreadTitle threadId={thread.id} />
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            <span className={`font-semibold ${tone.word}`}>{tone.label}</span>
            {projectName === null ? null : ` · ${projectName}`}
            {` · ${noticeAge(notice.receivedAt, now)}`}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          disabled={phase.kind === "leaving"}
          onClick={dismiss}
          className={`pointer-events-auto relative -mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-[7px] text-muted-foreground ${CONTROL_HOVER_TRANSITION} hover:bg-foreground/8 hover:text-foreground`}
        >
          {countdown === null ? null : (
            <CountdownRing countdown={countdown} className={tone.ring} />
          )}
          <CloseGlyph />
        </button>
      </div>
      <div className="pointer-events-none relative">
        {phase.tone === "needs-you" ? (
          <NeedsYouBody
            entry={entry}
            question={loaded?.tone === "needs-you" ? loaded.question : null}
            send={send}
          />
        ) : (
          <FailedBody
            entry={entry}
            state={loaded?.tone === "failed" ? loaded.continuation : null}
            send={send}
          />
        )}
      </div>
      <div className="relative -mx-3 -mb-2.5 mt-3 grid grid-cols-2 border-t border-foreground/10 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/notice:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/notice:opacity-100">
        <button
          type="button"
          disabled={phase.kind === "leaving"}
          className={`flex h-10 min-w-0 items-center justify-center bg-foreground/5 text-xs font-semibold text-foreground ${CONTROL_HOVER_TRANSITION} hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
          onClick={open}
        >
          Open chat
        </button>
        <button
          type="button"
          disabled={phase.kind === "leaving"}
          className={`flex h-10 min-w-0 items-center justify-center border-l border-foreground/10 bg-foreground/2 text-xs font-semibold text-muted-foreground ${CONTROL_HOVER_TRANSITION} hover:bg-foreground/8 hover:text-foreground focus-visible:bg-foreground/8 focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
          onClick={dismiss}
        >
          Later
        </button>
      </div>
    </article>
  );
}

function NeedsYouBody({
  entry,
  question,
  send,
}: {
  entry: ShownChatNotice;
  question: NativeQuestion | null;
  send: Send;
}) {
  if (question === null) return <NoticeText>{entry.notice.body}</NoticeText>;

  return <QuestionBody entry={entry} question={question} send={send} />;
}

function QuestionBody({
  entry,
  question,
  send,
}: {
  entry: ShownChatNotice;
  question: NativeQuestion;
  send: Send;
}) {
  const sdk = useSdk();
  const [expanded, setExpanded] = useState(false);
  const { notice, phase } = entry;
  const options = quickAnswers(question);
  const busy = phase.kind !== "card";

  const answer = (option: NativeQuestionOption) => {
    send({ type: "send", noticeId: notice.id });
    sdk.experimental_attention
      .command({
        threadId: notice.threadId,
        command: {
          action: "answer",
          id: question.id,
          revision: question.revision,
          answer: { selected: [option.value] },
        },
      })
      .then(
        () =>
          send({
            type: "sent",
            noticeId: notice.id,
            detail: `Sent “${option.label}”`,
          }),
        () =>
          send({
            type: "fail",
            noticeId: notice.id,
            error: "Could not send. Try again.",
          }),
      );
  };

  return (
    <>
      <p className="relative ml-9 mt-2 line-clamp-3 text-sm leading-normal text-foreground/92">
        {question.question.prompt}
      </p>
      <NoticeOutcome phase={phase}>
        <div className="relative ml-9 mt-2.5 flex flex-wrap gap-1.5">
          {options === null ? (
            <button
              type="button"
              aria-expanded={expanded}
              disabled={busy}
              onClick={() => setExpanded((open) => !open)}
              className={CHOICE}
            >
              Answer here
            </button>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={busy}
                aria-label={
                  option.recommended
                    ? `${option.label} (Recommended)`
                    : undefined
                }
                onClick={() => answer(option)}
                className={option.recommended ? PRIMARY_CHOICE : CHOICE}
              >
                {option.label}
                {option.recommended ? (
                  <span aria-hidden className="ml-1 text-2xs opacity-70">
                    ★
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        {expanded && options === null ? (
          <div className="pointer-events-auto relative ml-9 mt-2 max-h-80 overflow-y-auto">
            <ThreadAttention threadId={notice.threadId} />
          </div>
        ) : null}
      </NoticeOutcome>
    </>
  );
}

function FailedBody({
  entry,
  state,
  send,
}: {
  entry: ShownChatNotice;
  state: ContinuationState | null;
  send: Send;
}) {
  const sdk = useSdk();
  const { notice, phase } = entry;

  const resumable =
    state !== null &&
    state.available &&
    state.action !== "unavailable" &&
    !state.pending;

  const resume = () => {
    send({ type: "send", noticeId: notice.id });
    sdk.threads.experimental_continue({ threadId: notice.threadId }).then(
      (result) =>
        send(
          result.outcome === "blocked"
            ? {
                type: "fail",
                noticeId: notice.id,
                error: result.message ?? "Could not continue. Try again.",
              }
            : { type: "sent", noticeId: notice.id, detail: "Continuing" },
        ),
      () =>
        send({
          type: "fail",
          noticeId: notice.id,
          error: "Could not continue. Try again.",
        }),
    );
  };

  return (
    <>
      <div className="relative ml-9 mt-2">
        <p className="line-clamp-4 whitespace-pre-wrap break-words rounded-lg bg-foreground/6 px-2 py-1.5 font-mono text-xs leading-normal text-foreground/82">
          {state?.message ?? notice.body}
        </p>
      </div>
      <NoticeOutcome phase={phase}>
        {resumable ? (
          <div className="relative ml-9 mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={phase.kind !== "card"}
              onClick={resume}
              className={PRIMARY_CHOICE}
            >
              Continue
            </button>
          </div>
        ) : state?.pending === true ? (
          <p
            role="status"
            className="relative ml-9 mt-2.5 text-xs text-muted-foreground"
          >
            Automatic recovery pending
          </p>
        ) : null}
      </NoticeOutcome>
    </>
  );
}

function NoticeText({ children }: { children: ReactNode }) {
  return (
    <p className="relative ml-9 mt-2 line-clamp-3 text-sm leading-normal text-foreground/92">
      {children}
    </p>
  );
}

function NoticeOutcome({
  phase,
  children,
}: {
  phase: ShownChatNoticePhase;
  children: ReactNode;
}) {
  if (phase.kind === "sent")
    return (
      <p
        role="status"
        className="relative ml-9 mt-2.5 flex items-center gap-1.5 text-xs font-semibold text-success"
      >
        <CheckGlyph />
        {phase.detail}
      </p>
    );

  return (
    <>
      {children}
      {phase.kind === "card" && phase.error !== null ? (
        <p
          role="alert"
          className="relative ml-9 mt-1.5 text-xs text-destructive-text"
        >
          {phase.error}
        </p>
      ) : null}
    </>
  );
}

function CountdownRing({
  countdown,
  className,
}: {
  countdown: Countdown;
  className: string;
}) {
  const circle = useRef<SVGCircleElement>(null);

  useLayoutEffect(() => {
    const node = circle.current;

    if (node === null) return;

    const animation = node.animate(
      [{ strokeDashoffset: "0px" }, { strokeDashoffset: `${RING_LENGTH}px` }],
      { duration: COUNTDOWN_MS, fill: "forwards" },
    );

    animation.currentTime = countdownElapsed(countdown, Date.now());

    if (countdown.runningSince === null) animation.pause();

    return () => animation.cancel();
  }, [countdown]);

  return (
    <svg
      aria-hidden
      data-countdown-ring=""
      viewBox="0 0 24 24"
      className="pointer-events-none absolute inset-0 size-6 -rotate-90"
    >
      <circle
        ref={circle}
        cx="12"
        cy="12"
        r="10"
        fill="none"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        className={className}
      />
    </svg>
  );
}

async function readOpenQuestion(
  sdk: experimental_PluginBrowserSdk,
  threadId: string,
  signal: AbortSignal,
): Promise<NoticeContent> {
  return {
    tone: "needs-you",
    question: openNativeQuestion(
      (await sdk.experimental_attention.history({ threadId, signal }))
        .questions,
    ),
  };
}

async function readNoQuestion(): Promise<NoticeContent> {
  return { tone: "needs-you", question: null };
}

async function readContinuation(
  sdk: experimental_PluginBrowserSdk,
  threadId: string,
  signal: AbortSignal,
): Promise<NoticeContent> {
  return {
    tone: "failed",
    continuation: await sdk.threads.experimental_continuationState({
      threadId,
      signal,
    }),
  };
}

function useThreadRead<T>(
  read: (
    sdk: experimental_PluginBrowserSdk,
    threadId: string,
    signal: AbortSignal,
  ) => Promise<T>,
  threadId: string,
  version: string,
): Remote<T> {
  const sdk = useSdk();

  const [result, setResult] = useState<{
    key: string;
    remote: Remote<T>;
  } | null>(null);

  const key = `${threadId}:${version}`;

  useEffect(() => {
    const controller = new AbortController();

    read(sdk, threadId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted)
          setResult({ key, remote: { status: "ready", value } });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ key, remote: { status: "failed" } });
      },
    );

    return () => controller.abort();
  }, [read, sdk, threadId, key]);

  return result?.key === key ? result.remote : { status: "loading" };
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);

    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}

function useChatNoticePlacement(
  active: boolean,
  openThreadId: string | null,
): ChatNoticePlacement {
  const [placement, setPlacement] =
    useState<ChatNoticePlacement>(INITIAL_PLACEMENT);

  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    let observed: readonly Element[] = [];
    const observer = new ResizeObserver(schedule);

    function measure() {
      const { layout, targets } = measureLayout();
      const next = placeChatNotices(layout);

      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );

      if (
        targets.length !== observed.length ||
        targets.some((target, index) => target !== observed[index])
      ) {
        observer.disconnect();

        for (const target of targets) observer.observe(target);
        observed = targets;
      }
    }

    function schedule() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    }

    measure();
    schedule();
    window.addEventListener("resize", schedule);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [active, openThreadId]);

  return placement;
}

function measureLayout(): {
  layout: ChatNoticeLayout;
  targets: readonly Element[];
} {
  const shell = document.querySelector("[data-app-content-shell]");
  const scope = shell ?? document.body;
  const column = leftmost(scope.querySelectorAll("[data-page-content-column]"));

  const viewport =
    column?.element.closest("[data-page-scroll-viewport]") ??
    leftmost(scope.querySelectorAll("[data-page-scroll-viewport]"))?.element ??
    null;

  return {
    layout: {
      shell:
        shell === null
          ? {
              left: 0,
              top: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            }
          : plainRect(shell.getBoundingClientRect()),
      column: column?.rect ?? null,
      viewportTop:
        viewport === null ? null : viewport.getBoundingClientRect().top,
      cardWidth: CARD_WIDTH,
      compact: window.innerWidth <= COMPACT_MAX_WIDTH,
    },
    targets: [shell, column?.element ?? null, viewport].filter(
      (target): target is Element => target !== null,
    ),
  };
}

function leftmost(
  elements: Iterable<Element>,
): { element: Element; rect: PlacementRect } | null {
  let found: { element: Element; rect: PlacementRect } | null = null;

  for (const element of elements) {
    const rect = element.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) continue;

    if (found === null || rect.left < found.rect.left)
      found = { element, rect: plainRect(rect) };
  }

  return found;
}

function plainRect({ left, top, width, height }: DOMRect): PlacementRect {
  return { left, top, width, height };
}

function samePlacement(
  left: ChatNoticePlacement,
  right: ChatNoticePlacement,
): boolean {
  return (
    left.mode === right.mode &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.visible === right.visible
  );
}

function keepsFocus(event: FocusEvent<HTMLElement>): boolean {
  return (
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  );
}

function noticeAge(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);

  if (minutes < 1) return "now";

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function QuestionGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      <path
        d="M5.6 6.1a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <circle cx="8" cy="12.6" r="1" fill="currentColor" />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      <path
        d="M8 3.6v5.3"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <circle cx="8" cy="12" r="1.05" fill="currentColor" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 12 12" className="relative size-3" aria-hidden>
      <path
        d="M3 3l6 6M9 3 3 9"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
      <path
        d="M2 5.2 4.1 7.2 8 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
