import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ThreadChat,
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useRpc,
  type PluginNavPanelProps,
} from "@omnyo/plugin-sdk/app";
import {
  CHIEF_PLUGIN_ID,
  type DeckCardView,
  type DeckView,
  type rpcContract,
} from "../lib/contract.ts";
import {
  ASSISTANT_TITLE,
  HOME_PATH,
  NEEDS_YOU_TITLE,
  TALK_LEAD,
  TALK_PLACEHOLDER,
  TAB_PATH,
  TIDY_HREF,
  ageLabel,
  cardRow,
  isAssistantTab,
  emptyKind,
  plural,
  projectChips,
  questionFromPath,
  sectionFor,
  showSwipeHint,
  tabFromPath,
  visibleCards,
  visibleTabs,
  type ChiefTab,
  type DeckSection,
} from "./chief-logic.ts";
import { keyIntent, suggestedChoice } from "./deck-logic.ts";
import { useDeck } from "./deck-store.ts";
import { DecidedTab } from "./decided.tsx";
import { ChiefDiamond } from "./icon.tsx";
import { SuggestionsOffer } from "./offer.tsx";
import { RulesTab } from "./rules.tsx";
import { DeckStack } from "./stack.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/utils.ts";
import { useCardOperations } from "./use-card-operations.ts";
import { useDeckActions, type FailedAnswer } from "./use-deck-actions.ts";
import { errorText } from "./use-loaded.ts";

const SETTINGS_HREF = `/settings/plugins/${CHIEF_PLUGIN_ID}`;

const READING_WIDTH = "mx-auto w-full max-w-[640px]";

const WIDE_MIN_PX = 760;

const SKELETON_DELAY_MS = 250;

const COARSE_POINTER = "(pointer: coarse)";

function useRpcAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    <T,>(call: () => Promise<T>) => {
      setBusy(true);
      setError(null);
      call()
        .then(onDone, (failure: Error) => setError(errorText(failure)))
        .finally(() => setBusy(false));
    },
    [onDone],
  );

  return { busy, error, run, clear: () => setError(null) };
}

function useWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;

    if (node === null) return;
    const measure = () => setWide(node.getBoundingClientRect().width >= WIDE_MIN_PX);

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(node);

    return () => observer.disconnect();
  }, [ref]);

  return wide;
}

function subscribeCoarse(onChange: () => void): () => void {
  const media = window.matchMedia(COARSE_POINTER);

  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
}

function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

function useDelayed(ms: number): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), ms);

    return () => window.clearTimeout(timer);
  }, [ms]);

  return shown;
}

function Centered({
  title,
  icon,
  children,
}: {
  title: string | null;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-16 text-center">
      {icon}
      {title === null ? null : <p className="m-0 text-sm font-medium">{title}</p>}
      {children}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Centered title={null}>
      <p role="alert" className="m-0 text-sm">
        Couldn&apos;t load this view.
      </p>
      <Button variant="outline" size="sm" className="mt-2 pointer-coarse:h-10" onClick={onRetry}>
        Try again
      </Button>
    </Centered>
  );
}

function ListSkeleton() {
  const shown = useDelayed(SKELETON_DELAY_MS);

  if (!shown) return <div aria-busy aria-label="Loading" />;

  return (
    <div aria-busy aria-label="Loading" className="flex flex-col gap-1 p-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-2.5 rounded-md px-3 py-2.5">
          <div className="mt-1.5 size-2 shrink-0 rounded-full bg-muted" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3 w-1/2 rounded bg-muted" />
            <div className="h-2.5 w-5/6 rounded bg-muted" />
            <div className="h-2.5 w-1/3 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBar({
  view,
  refresh,
  onReview,
}: {
  view: DeckView;
  refresh: () => void;
  onReview: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const action = useRpcAction(refresh);
  const line = view.statusLine;

  if (line === null || line.kind === "migration") return null;

  const button =
    line.action === "resume"
      ? { label: "Resume…", run: () => action.run(() => rpc.call("resume")) }
      : line.action === "retry"
        ? {
            label: "Try again",
            run: () =>
              line.kind === "failing"
                ? action.run(() => rpc.call("suggestions.retry"))
                : action.run(() => rpc.call("home.repair")),
          }
        : line.action === "review"
          ? { label: "Review", run: onReview }
          : null;

  const alert = line.kind === "failing" || line.kind === "no-computer";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-xs">
      <span className={cn("flex items-center gap-1.5", alert && "text-destructive-text")}>
        {alert ? <Icon name="AlertCircle" className="size-3.5" aria-hidden /> : null}
        {line.text}
      </span>
      {button === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs pointer-coarse:h-10"
          disabled={action.busy}
          onClick={button.run}
        >
          {button.label}
        </Button>
      )}
      {action.error === null ? null : (
        <span role="alert" className="text-destructive-text">
          {action.error}
        </span>
      )}
    </div>
  );
}

function AssistantControls({ view, refresh }: { view: DeckView; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const action = useRpcAction(refresh);
  const paused = view.delegation.paused;
  const suggesting = view.suggestions === "on";

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>Answer suggestions are {suggesting ? "on" : "off"}.</span>
        <a href={SETTINGS_HREF} className="text-foreground underline underline-offset-2">
          Assistant settings
        </a>
      </div>
      {view.canAnswerForMe ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {paused
              ? "Answers for you are paused."
              : suggesting
                ? "Chief can answer under your approved rules."
                : "Answers for you are off with suggestions."}
          </span>
          {suggesting ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto pointer-coarse:min-h-11"
              disabled={action.busy}
              onClick={() => action.run(() => rpc.call(paused ? "resume" : "pause"))}
            >
              {paused ? "Resume answering…" : "Pause answering for me"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {action.error === null ? null : (
        <span role="alert" className="text-xs text-destructive-text">
          {action.error}
        </span>
      )}
    </div>
  );
}

const TAB_LABEL: Record<ChiefTab, string> = {
  decide: "Needs action",
  saved: "Saved",
  talk: "Ask Chief",
  replies: "Suggested replies",
  rules: "Rules",
  decided: "Answered for you",
};

function Tabs({
  tabs,
  current,
  counts,
  onSelect,
}: {
  tabs: readonly ChiefTab[];
  current: ChiefTab;
  counts: Partial<Record<ChiefTab, number>>;
  onSelect: (tab: ChiefTab) => void;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs.at(-1)
          : event.key === "ArrowRight"
            ? tabs[(index + 1) % tabs.length]
            : event.key === "ArrowLeft"
              ? tabs[(index + tabs.length - 1) % tabs.length]
              : undefined;

    if (next === undefined) return;

    event.preventDefault();
    document.getElementById(`chief-tab-${next}`)?.focus();
    onSelect(next);
  };

  return (
    <div
      role="tablist"
      aria-label={isAssistantTab(current) ? ASSISTANT_TITLE : NEEDS_YOU_TITLE}
      className="flex min-w-0 flex-wrap gap-x-1 self-stretch"
    >
      {tabs.map((tab, index) => {
        const count = counts[tab];

        return (
          <button
            key={tab}
            id={`chief-tab-${tab}`}
            type="button"
            role="tab"
            tabIndex={tab === current ? 0 : -1}
            aria-selected={tab === current}
            aria-controls="chief-tab-panel"
            className={cn(
              "flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 border-0 border-b-2 border-transparent bg-transparent px-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-12",
              tab === current && "border-foreground font-medium text-foreground",
            )}
            onClick={() => onSelect(tab)}
            onKeyDown={(event) => move(event, index)}
          >
            {TAB_LABEL[tab]}
            {count === undefined || count === 0 ? null : (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ProjectChips({
  projects,
  selected,
  onSelect,
}: {
  projects: readonly string[];
  selected: string | null;
  onSelect: (project: string | null) => void;
}) {
  const chip =
    "h-6 shrink-0 cursor-pointer rounded-full border border-border bg-transparent px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:border-transparent aria-pressed:bg-state-active aria-pressed:text-foreground pointer-coarse:h-8";

  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto px-2 pt-1 pb-2 [scrollbar-width:none]">
      <button
        type="button"
        className={chip}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        All projects
      </button>
      {projects.map((project) => (
        <button
          key={project}
          type="button"
          className={chip}
          aria-pressed={selected === project}
          onClick={() => onSelect(project)}
        >
          {project}
        </button>
      ))}
    </div>
  );
}

function SwipeHint({ onDone }: { onDone: () => void }) {
  return (
    <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <span className="flex-1">
        Swipe right for the main action, left for another choice, or up to save for later.
      </span>
      <Button variant="outline" size="sm" className="h-7 text-xs pointer-coarse:h-10" onClick={onDone}>
        Got it
      </Button>
    </div>
  );
}

function CaughtUp({ view, firstRun }: { view: DeckView; firstRun: boolean }) {
  const icon = <Icon name="CircleCheck" className="mb-1 size-6 text-muted-foreground" aria-hidden />;

  if (firstRun)
    return (
      <Centered title="Nothing needs you yet" icon={icon}>
        <p className="m-0 text-sm text-muted-foreground">
          Questions and blocked chats from all your projects appear here.
        </p>
      </Centered>
    );

  return (
    <Centered title="All caught up" icon={icon}>
      {view.saved > 0 ? (
        <p className="m-0 text-sm text-muted-foreground">{view.saved} saved for later</p>
      ) : null}
      {view.archiveReady > 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          {plural(view.archiveReady, "chat is", "chats are")} ready to archive.{" "}
          <a href={TIDY_HREF} className="text-foreground underline underline-offset-2">
            Review
          </a>
        </p>
      ) : null}
    </Centered>
  );
}

function markClass(card: DeckCardView): string {
  if (card.kind === "problem") return "bg-destructive";

  if (card.kind === "result") return "bg-success";

  return card.required ? "bg-attention" : "border border-attention";
}

function CardRowButton({
  card,
  review,
  now,
  selected,
  failed,
  onPick,
}: {
  card: DeckCardView;
  review: DeckView["ruleReviews"][string] | undefined;
  now: number;
  selected: boolean;
  failed: boolean;
  onPick: (key: string) => void;
}) {
  const row = cardRow(card, review);
  const choice = suggestedChoice(card);

  const unavailable =
    choice === null &&
    card.steps.some((step) => step.verdict === null && step.triageError !== null);

  const meta = [
    row.context,
    card.kind === "problem" ? "Failed" : null,
    card.required ? "Required" : null,
  ].filter((part): part is string => part !== null);

  return (
    <button
      type="button"
      data-card-key={card.key}
      aria-current={selected ? "true" : undefined}
      className="flex w-full cursor-pointer gap-2.5 rounded-md border-0 bg-transparent px-3 py-2.5 text-left hover:bg-state-hover focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=true]:bg-state-active pointer-coarse:py-3"
      onClick={() => onPick(card.key)}
    >
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", markClass(card))} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {ageLabel(card.since, now)}
          </span>
        </span>
        {row.preview === null ? null : (
          <span className="line-clamp-2 text-xs text-muted-foreground">{row.preview}</span>
        )}
        {meta.length === 0 ? null : (
          <span className="truncate text-2xs text-muted-foreground">{meta.join(" · ")}</span>
        )}
        {failed ? (
          <span className="text-2xs text-destructive-text">Answer failed to send</span>
        ) : choice !== null ? (
          <span className="truncate text-2xs text-muted-foreground">
            Chief suggests <span className="text-foreground">{choice}</span>
          </span>
        ) : unavailable ? (
          <span className="text-2xs text-muted-foreground">Suggestion unavailable</span>
        ) : null}
      </span>
    </button>
  );
}

function CardList({
  cards,
  view,
  selected,
  failedAnswers,
  onPick,
  onMove,
}: {
  cards: readonly DeckCardView[];
  view: DeckView;
  selected: string | undefined;
  failedAnswers: ReadonlyMap<string, FailedAnswer>;
  onPick: (key: string) => void;
  onMove: (key: string) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "j"
        ? 1
        : event.key === "ArrowUp" || event.key === "k"
          ? -1
          : 0;

    if (step === 0 || event.metaKey || event.ctrlKey || event.altKey) return;

    const from = cards.findIndex(
      (card) =>
        card.key ===
        (event.target instanceof HTMLElement ? event.target.dataset.cardKey : undefined),
    );

    const next = cards[Math.max(0, Math.min(cards.length - 1, from + step))];

    if (next === undefined) return;
    event.preventDefault();
    onMove(next.key);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-card-key="${CSS.escape(next.key)}"]`)
      ?.focus();
  };

  return (
    <ul className="m-0 flex list-none flex-col gap-px p-0" onKeyDown={onKeyDown}>
      {cards.map((card) => (
        <li key={card.key}>
          <CardRowButton
            card={card}
            review={view.ruleReviews[card.key]}
            now={view.generatedAt}
            selected={card.key === selected}
            failed={failedAnswers.has(card.key)}
            onPick={onPick}
          />
        </li>
      ))}
    </ul>
  );
}

function ExistingRules({ rules }: { rules: DeckView["ruleReviews"][string]["adopted"] }) {
  if (rules.length === 0) return null;

  return (
    <details className="rounded-md border border-border px-3 py-2 text-sm">
      <summary className="cursor-pointer">Compare with adopted rules</summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0">
        {rules.map((rule) => (
          <li key={rule.id}>
            <p className="m-0 text-xs text-muted-foreground">{rule.scope}</p>
            <p className="m-0">{rule.cue}</p>
            <p className="m-0">{rule.action}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SavedTab({ view, refresh }: { view: DeckView; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const action = useRpcAction(refresh);
  const savedList = useRef<HTMLDivElement>(null);

  return (
    <div ref={savedList} tabIndex={-1} className={cn(READING_WIDTH, "px-4 py-4")}>
      {action.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {action.error}
        </p>
      )}
      {view.savedCards.length === 0 ? (
        <Centered title="Nothing saved for later">{null}</Centered>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {view.savedCards.map(({ card, until }) => {
            const row = cardRow(card, view.ruleReviews[card.key]);

            return (
              <li
                key={card.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2.5 hover:bg-state-hover"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-medium">{row.title}</p>
                  <p className="m-0 truncate text-2xs text-muted-foreground">
                    {[row.context, `Returns ${new Date(until).toLocaleString()}`]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await rpc.call("unsnooze", { cardKey: card.key, until });
                      savedList.current?.focus();
                    })
                  }
                >
                  Restore now
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DeckTab({
  view,
  refresh,
  active,
  wide,
  project,
  chips,
  footer,
  section,
  linkedQuestion,
  onClearLink,
}: {
  view: DeckView;
  refresh: () => void;
  active: boolean;
  wide: boolean;
  project: string | null;
  chips: ReactNode;
  footer: ReactNode;
  section: DeckSection;
  linkedQuestion: string | null;
  onClearLink: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const actions = useDeckActions(refresh);
  const operations = useCardOperations(actions);
  const coarse = useCoarsePointer();
  const [hintDone, setHintDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const lastCard = useRef<string | undefined>(undefined);
  const position = useRef(0);
  const focusDetail = useRef(false);
  const { prune, undo } = actions;

  useEffect(() => {
    prune(view.cards);
  }, [prune, view.cards]);

  const cards = visibleCards(
    view.cards.filter((card) => sectionFor(card) === section && !actions.hidden.has(card.key)),
    view.suggestions,
    project,
  );

  const linkedCard =
    linkedQuestion === null
      ? undefined
      : cards.find((item) => item.steps.some((step) => step.question.id === linkedQuestion));

  const card =
    linkedCard ??
    cards.find((item) => item.key === selected) ??
    (wide
      ? cards.find((item) => actions.failedAnswers.has(item.key)) ??
        cards[Math.min(position.current, cards.length - 1)]
      : undefined);

  const cardKey = card?.key;

  useEffect(() => {
    if (card !== undefined) position.current = Math.max(0, cards.indexOf(card));
  });

  useEffect(() => {
    if (!active || lastCard.current === cardKey) return;
    const previous = lastCard.current;

    lastCard.current = cardKey;

    if (cardKey !== undefined) {
      const inList = list.current?.contains(document.activeElement) === true;
      const go = focusDetail.current || (previous !== undefined && !inList);

      focusDetail.current = false;

      if (go) detail.current?.focus();

      return;
    }

    const row = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>("[data-card-key]") ?? [],
    ).find((item) => item.dataset.cardKey === previous);

    (row ?? list.current?.querySelector("button") ?? list.current)?.focus();
  }, [active, cardKey]);

  const pick = (key: string) => {
    focusDetail.current = true;
    setSelected(key);
  };

  const closeCard = () => {
    if (wide && cardKey !== undefined) {
      list.current
        ?.querySelector<HTMLButtonElement>(`[data-card-key="${CSS.escape(cardKey)}"]`)
        ?.focus();

      return;
    }

    setSelected(null);

    if (linkedQuestion !== null) onClearLink();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape" && card !== undefined) {
      event.preventDefault();
      closeCard();

      return;
    }

    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, select, [contenteditable=true]")
    )
      return;

    if (keyIntent(event.key)?.kind !== "undo") return;

    event.preventDefault();
    undo();
  };

  const dismissHint = () => {
    setHintDone(true);
    rpc.call("hint.seen").then(refresh, () => setHintDone(false));
  };

  const offer =
    view.suggestions === "undecided" ? (
      <SuggestionsOffer
        agent={view.agent}
        onChanged={refresh}
        className="border-t border-border pt-3"
      />
    ) : null;

  const empty =
    section === "decide" ? (
      project !== null && view.toDecide > 0 ? (
        <Centered title="Nothing needs action in this project">{null}</Centered>
      ) : (
        <CaughtUp view={view} firstRun={emptyKind(view, actions.handled) === "first-run"} />
      )
    ) : section === "replies" ? (
      <Centered title="No suggested replies">{null}</Centered>
    ) : (
      <Centered title="No proposed rules">{null}</Centered>
    );

  const listPane = (
    <div ref={list} tabIndex={-1} aria-label={TAB_LABEL[section]} className="p-2">
      {chips}
      {cards.length === 0 ? empty : (
        <CardList
          cards={cards}
          view={view}
          selected={wide ? cardKey : undefined}
          failedAnswers={actions.failedAnswers}
          onPick={pick}
          onMove={setSelected}
        />
      )}
    </div>
  );

  const detailPane =
    card === undefined ? null : (
      <div
        className={cn(
          "w-full max-w-[640px]",
          wide ? "px-8 pt-6 pb-16" : "mx-auto px-4 pt-2 pb-24",
        )}
      >
        {wide ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 -ml-2 pointer-coarse:min-h-11"
            onClick={closeCard}
          >
            <Icon name="ChevronLeft" aria-hidden />
            {TAB_LABEL[section]}
          </Button>
        )}
        {section === "decide" && coarse && !hintDone && showSwipeHint(view, cards.length) ? (
          <SwipeHint onDone={dismissHint} />
        ) : null}
        <DeckStack
          key={card.key}
          card={card}
          framed={!wide}
          operations={operations}
          suggestions={view.suggestions}
          offer={offer}
          comparisons={<ExistingRules rules={view.ruleReviews[card.key]?.adopted ?? []} />}
          failedAnswer={actions.failedAnswers.get(card.key) ?? null}
          discardFailedAnswer={() => actions.discardFailedAnswer(card.key)}
        />
      </div>
    );

  return (
    <div hidden={!active} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {actions.error === null ? null : (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-sm text-destructive-text"
        >
          <span>{actions.error}</span>
          <Button variant="ghost" size="sm" onClick={actions.dismissError}>
            Dismiss
          </Button>
        </div>
      )}
      {wide && cards.length > 0 ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-border">{listPane}</div>
          <div
            ref={detail}
            tabIndex={-1}
            aria-label="Selected item"
            className="min-h-0 overflow-y-auto outline-none"
          >
            {detailPane}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {card === undefined ? (
            listPane
          ) : (
            <div ref={detail} tabIndex={-1} aria-label="Selected item" className="outline-none">
              {detailPane}
            </div>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}

function TalkTab({ view, refresh }: { view: DeckView; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const repair = useRpcAction(refresh);

  if (view.home === "ready" && view.chiefThreadId !== null)
    return (
      <ThreadChat
        threadId={view.chiefThreadId}
        className="min-h-0 flex-1"
        experimental_placeholder={TALK_PLACEHOLDER}
        leadingContent={<p className="m-0 text-sm text-muted-foreground">{TALK_LEAD}</p>}
      />
    );

  if (view.home === "starting")
    return (
      <Centered title={null}>
        <p className="m-0 text-sm text-muted-foreground">Setting up the Chief…</p>
      </Centered>
    );

  if (view.home === "unsupported")
    return (
      <Centered title={null}>
        <p className="m-0 text-sm text-muted-foreground">
          Talking to the Chief needs a newer Omnyo.
        </p>
      </Centered>
    );

  return (
    <Centered title={null}>
      <p className="m-0 text-sm">The Chief needs a computer connected to this Omnyo to talk.</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 pointer-coarse:h-10"
        disabled={repair.busy}
        onClick={() => repair.run(() => rpc.call("home.repair"))}
      >
        Try again
      </Button>
      {repair.error === null ? null : (
        <p role="alert" className="m-0 text-xs text-destructive-text">
          {repair.error}
        </p>
      )}
    </Centered>
  );
}

export function ChiefPage({ subPath }: PluginNavPanelProps) {
  const nav = experimental_useAppNavigate();
  const tab = tabFromPath(subPath);
  const assistant = isAssistantTab(tab);
  const linkedQuestion = questionFromPath(subPath);
  const { value, error, updating, refresh } = useDeck();
  const [project, setProject] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wide = useWide(panel);

  const select = (next: ChiefTab) =>
    nav.toPluginPanel(HOME_PATH, { subPath: TAB_PATH[next], replace: true });

  const decisions =
    value === null ? [] : value.cards.filter((card) => sectionFor(card) === "decide");

  const chips = projectChips(decisions);
  const tabs = visibleTabs(value, tab);
  const selectedProject = project !== null && chips.includes(project) ? project : null;

  const counts: Partial<Record<ChiefTab, number>> =
    value === null
      ? {}
      : {
          decide: decisions.length,
          replies: visibleCards(
            value.cards.filter((card) => sectionFor(card) === "replies"),
            value.suggestions,
            null,
          ).length,
          saved: value.savedCards.length,
        };

  const deckSection = tab === "decide" || tab === "rules" || tab === "replies";

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      <h1 id="chief-view-heading" className="sr-only">
        {assistant ? ASSISTANT_TITLE : NEEDS_YOU_TITLE}
      </h1>
      <div className="grid min-h-11 shrink-0 items-center gap-x-2 border-b border-border px-2 @lg:flex pointer-coarse:min-h-12">
        {assistant ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 pointer-coarse:min-h-11"
            onClick={() => select("decide")}
          >
            <Icon name="ChevronLeft" aria-hidden />
            {NEEDS_YOU_TITLE}
          </Button>
        ) : null}
        {tabs.length > 1 ? (
          <Tabs tabs={tabs} current={tab} counts={counts} onSelect={select} />
        ) : (
          <span className="flex min-h-11 items-center gap-1.5 px-2 text-sm font-medium">
            {TAB_LABEL[tab]}
            {counts[tab] === undefined || counts[tab] === 0 ? null : (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {counts[tab]}
              </span>
            )}
          </span>
        )}
        {assistant && !updating ? null : (
          <div className="ml-auto flex min-h-11 items-center gap-2">
            {updating ? (
              <span role="status" className="shrink-0 text-xs text-muted-foreground">
                Updating…
              </span>
            ) : null}
            {assistant ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 pointer-coarse:min-h-11"
                onClick={() => select("talk")}
              >
                <ChiefDiamond className="size-3" />
                {ASSISTANT_TITLE}
              </Button>
            )}
          </div>
        )}
      </div>
      {value === null || (assistant && value.statusLine?.kind === "paused") ? null : (
        <StatusBar view={value} refresh={refresh} onReview={() => select("decided")} />
      )}
      {assistant && value !== null ? <AssistantControls view={value} refresh={refresh} /> : null}
      {value !== null && error !== null ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5 text-xs">
          <span role="alert">Couldn&apos;t refresh this view.</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={refresh}>
            Try again
          </Button>
        </div>
      ) : null}
      <div
        ref={panel}
        id="chief-tab-panel"
        role={tabs.length > 1 ? "tabpanel" : "region"}
        aria-labelledby={tabs.length > 1 ? `chief-tab-${tab}` : "chief-view-heading"}
        className="flex min-h-0 flex-1 flex-col"
      >
        {value === null ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {error === null ? <ListSkeleton /> : <LoadError onRetry={refresh} />}
          </div>
        ) : (
          <>
            <DeckTab
              view={value}
              refresh={refresh}
              active={deckSection}
              wide={wide && tab !== "rules"}
              project={tab === "decide" && linkedQuestion === null ? selectedProject : null}
              chips={
                tab === "decide" && chips.length > 0 ? (
                  <ProjectChips
                    projects={chips}
                    selected={selectedProject}
                    onSelect={setProject}
                  />
                ) : null
              }
              footer={
                tab === "rules" ? (
                  <div className="border-t border-border">
                    <RulesTab takeRate={value.takeRate} />
                  </div>
                ) : null
              }
              section={tab === "rules" || tab === "replies" ? tab : "decide"}
              linkedQuestion={linkedQuestion}
              onClearLink={() => select("decide")}
            />
            {deckSection || tab === "talk" ? null : (
              <div className="min-h-0 flex-1 overflow-auto">
                {tab === "saved" ? <SavedTab view={value} refresh={refresh} /> : null}
                {tab === "decided" ? <DecidedTab /> : null}
              </div>
            )}
            {tab === "talk" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <TalkTab view={value} refresh={refresh} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
