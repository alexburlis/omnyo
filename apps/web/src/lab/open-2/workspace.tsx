import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ArrowUp,
  BoltIcon,
  BranchIcon,
  Check,
  ChevronDown,
  GearIcon,
  GridIcon,
  InboxIcon,
  LoopIcon,
  MicIcon,
  NewThreadIcon,
  PlusIcon,
  ProviderGlyph,
  Spinner,
  ToolGlyph,
} from "./icons";
import {
  BrowserPanel,
  DiffPanel,
  IssuesPanel,
  PreviewPanel,
  TerminalPanel,
} from "./panels";
import {
  AUTO_ORDER,
  CHARS_PER_MS,
  PROVIDER_NAME,
  THREADS,
  type Thread,
  type ThreadItem,
  threadActivity,
  threadElapsed,
} from "./threads";

const TICK_MS = 80;

const AUTO_MS = 8200;

function useClock(frozen: boolean, target: RefObject<HTMLElement | null>) {
  const [clock, setClock] = useState(0);

  useEffect(() => {
    if (frozen) return;
    let visible = true;
    let last = performance.now();
    const node = target.current;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      last = performance.now();
    });

    if (node) observer.observe(node);

    const id = window.setInterval(() => {
      const now = performance.now();
      const delta = Math.min(now - last, 250);
      last = now;

      if (visible && !document.hidden) setClock((value) => value + delta);
    }, TICK_MS);

    return () => {
      window.clearInterval(id);
      observer.disconnect();
    };
  }, [frozen, target]);

  return clock;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

const SECTIONS = [
  { id: "running", label: "Running" },
  { id: "needs", label: "Needs you" },
  { id: "open", label: "Open" },
] as const;

const PROJECTS = [
  { initials: "pw", hue: 152, active: true },
  { initials: "pa", hue: 228, badge: 1 },
  { initials: "dk", hue: 300 },
  { initials: "ms", hue: 32 },
];

function StatusDot({ thread, running }: { thread: Thread; running: boolean }) {
  if (running) {
    return (
      <span className={`o2-status o2-status--run o2-tint-${thread.provider}`}>
        <Spinner />
      </span>
    );
  }

  if (thread.section === "needs") {
    return <span className="o2-status o2-status--needs" />;
  }

  if (thread.section === "open") {
    return <span className="o2-status o2-status--idle" />;
  }

  return <span className="o2-status o2-status--done" />;
}

function ChatItem({
  item,
  elapsed,
  thread,
}: {
  item: ThreadItem;
  elapsed: number;
  thread: Thread;
}) {
  if (item.kind === "user") {
    return (
      <div className="o2-msg o2-msg--user">
        <p>{item.text}</p>
      </div>
    );
  }

  if (item.kind === "note") {
    return (
      <div className="o2-msg o2-msg--note">
        <span>{item.text}</span>
      </div>
    );
  }

  if (item.kind === "agent") {
    const count = Math.min(
      item.text.length,
      Math.floor((elapsed - item.at) * CHARS_PER_MS),
    );

    const streaming = count < item.text.length;

    return (
      <div className="o2-msg o2-msg--agent">
        <p>
          {item.text.slice(0, count)}
          {streaming ? (
            <span className={`o2-caret o2-tint-${thread.provider}`} />
          ) : null}
        </p>
      </div>
    );
  }

  if (item.kind === "shots") {
    return (
      <div className="o2-msg o2-shots">
        {item.shots.map((shot) => (
          <figure key={shot.label} className={`o2-shot o2-shot--${shot.size}`}>
            <div className="o2-shot-img">
              <i />
              <i />
              <i />
              <span />
            </div>
            <figcaption>{shot.label}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  const done = elapsed >= item.done;

  return (
    <div className={done ? "o2-tool o2-tool--done" : "o2-tool"}>
      <span className="o2-tool-icon">
        <ToolGlyph icon={item.icon} />
      </span>
      <span className="o2-tool-label">{item.label}</span>
      {item.detail ? (
        <span className="o2-tool-detail">{item.detail}</span>
      ) : null}
      <span className="o2-tool-end">
        {done ? (
          <>
            {item.result ? (
              <span
                className={
                  item.tone
                    ? `o2-tool-result o2-tool-result--${item.tone}`
                    : "o2-tool-result"
                }
              >
                {item.result}
              </span>
            ) : null}
            <span className="o2-tool-check">
              <Check size={11} />
            </span>
          </>
        ) : (
          <Spinner />
        )}
      </span>
    </div>
  );
}

function Panel({ thread, elapsed }: { thread: Thread; elapsed: number }) {
  if (thread.panel === "preview") return <PreviewPanel elapsed={elapsed} />;

  if (thread.panel === "terminal") return <TerminalPanel elapsed={elapsed} />;

  if (thread.panel === "diff") return <DiffPanel elapsed={elapsed} />;

  if (thread.panel === "issues") return <IssuesPanel elapsed={elapsed} />;

  return <BrowserPanel elapsed={elapsed} />;
}

export function Workspace({
  onProviderChange,
}: {
  onProviderChange?: (provider: Thread["provider"]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const clock = useClock(reduced, root);
  const [activeId, setActiveId] = useState("drafts");
  const [pin, setPin] = useState<"auto" | "hover" | "click">("auto");
  const pinned = pin !== "auto";
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat");
  const [swapKey, setSwapKey] = useState(0);
  const hoverTimer = useRef(0);

  useEffect(() => {
    if (pinned || reduced) return;

    const id = window.setInterval(() => {
      setActiveId((current) => {
        const next =
          AUTO_ORDER[(AUTO_ORDER.indexOf(current) + 1) % AUTO_ORDER.length] ??
          "drafts";

        return next;
      });
      setSwapKey((value) => value + 1);
    }, AUTO_MS);

    return () => window.clearInterval(id);
  }, [pinned, reduced]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const active = THREADS.find((thread) => thread.id === activeId) ?? THREADS[0];

  useEffect(() => {
    if (active) onProviderChange?.(active.provider);
  }, [active, onProviderChange]);

  if (!active) return null;

  const choose = (id: string, mode: "hover" | "click") => {
    setPin((current) => (current === "click" ? current : mode));

    if (id !== activeId) {
      setActiveId(id);
      setSwapKey((value) => value + 1);
    }
  };

  const elapsed = threadElapsed(active, clock, reduced);
  const activity = threadActivity(active, elapsed);
  const visible = active.items.filter((item) => item.at <= elapsed);
  const last = visible[visible.length - 1];

  const streaming =
    last?.kind === "agent" &&
    (elapsed - last.at) * CHARS_PER_MS < last.text.length;

  const toolBusy = last?.kind === "tool" && elapsed < last.done;

  const counts = THREADS.reduce(
    (total, thread) => {
      const state = threadActivity(
        thread,
        threadElapsed(thread, clock, reduced),
      );

      if (state.running) total.running += 1;
      else if (thread.section === "needs") total.needs += 1;

      return total;
    },
    { running: 0, needs: 0 },
  );

  return (
    <div
      ref={root}
      className={`o2-ws o2-ws--${active.provider} o2-ws--view-${mobileView}`}
      onPointerLeave={() => {
        window.clearTimeout(hoverTimer.current);
        setPin((current) => (current === "hover" ? "auto" : current));
      }}
    >
      <header className="o2-ws-top">
        <span className="o2-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div className="o2-ws-title">
          <strong>{active.title}</strong>
          <span>{active.project} · studio-mac</span>
        </div>
        <div className={activity.running ? "o2-pill o2-pill--run" : "o2-pill"}>
          <span className={`o2-pill-dot o2-tint-${active.provider}`} />
          <span className="o2-pill-text">
            {activity.running
              ? `${PROVIDER_NAME[active.provider]} · ${activity.text}`
              : activity.text}
          </span>
        </div>
        <div className="o2-branch">
          <BranchIcon />
          <span>{active.branch}</span>
        </div>
        <div className="o2-seg" role="tablist" aria-label="Demo view">
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "chat"}
            onClick={() => setMobileView("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "panel"}
            onClick={() => setMobileView("panel")}
          >
            {active.panelLabel}
          </button>
        </div>
      </header>

      <div className="o2-ws-body">
        <nav className="o2-rail" aria-hidden="true">
          <span className="o2-rail-btn o2-rail-btn--inbox">
            <InboxIcon />
            <em>{counts.needs}</em>
          </span>
          <span className="o2-rail-sep" />
          {PROJECTS.map((project) => (
            <span
              key={project.initials}
              className={project.active ? "o2-proj o2-proj--on" : "o2-proj"}
              style={{ "--h": project.hue } as CSSProperties}
            >
              {project.initials}
              {project.badge ? <em>{project.badge}</em> : null}
            </span>
          ))}
          <span className="o2-rail-fill" />
          <span className="o2-rail-btn">
            <GridIcon />
          </span>
          <span className="o2-rail-btn">
            <LoopIcon />
          </span>
          <span className="o2-rail-btn">
            <BoltIcon />
          </span>
          <span className="o2-rail-btn">
            <GearIcon />
          </span>
        </nav>

        <aside className="o2-list" aria-label="Demo threads">
          <div className="o2-list-new" aria-hidden="true">
            <NewThreadIcon />
            New thread
            <kbd>⌘N</kbd>
          </div>
          {SECTIONS.map((section) => {
            const threads = THREADS.filter(
              (thread) => thread.section === section.id,
            );

            return (
              <div key={section.id} className={`o2-sec o2-sec--${section.id}`}>
                <div className="o2-sec-head">
                  <span>{section.label}</span>
                  <i />
                  <b>{threads.length}</b>
                </div>
                {threads.map((thread) => {
                  const state = threadActivity(
                    thread,
                    threadElapsed(thread, clock, reduced),
                  );

                  const on = thread.id === active.id;

                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={on ? "o2-row o2-row--on" : "o2-row"}
                      aria-pressed={on}
                      onClick={() => choose(thread.id, "click")}
                      onPointerEnter={(event) => {
                        if (event.pointerType !== "mouse") return;
                        window.clearTimeout(hoverTimer.current);
                        hoverTimer.current = window.setTimeout(
                          () => choose(thread.id, "hover"),
                          140,
                        );
                      }}
                      onPointerLeave={() =>
                        window.clearTimeout(hoverTimer.current)
                      }
                    >
                      <StatusDot thread={thread} running={state.running} />
                      <span className="o2-row-text">
                        <span className="o2-row-title">{thread.title}</span>
                        <span className="o2-row-sub">
                          <ProviderGlyph provider={thread.provider} size={10} />
                          {PROVIDER_NAME[thread.provider]}
                          <i>·</i>
                          <span className="o2-row-act">{state.text}</span>
                        </span>
                      </span>
                      <span className="o2-row-role">{thread.role}</span>
                      {on && !pinned && !reduced ? (
                        <i
                          key={`${active.id}-${swapKey}`}
                          className={`o2-row-progress o2-row-progress--${thread.provider}`}
                          style={
                            {
                              "--auto": `${AUTO_MS}ms`,
                            } as CSSProperties
                          }
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </aside>

        <section className="o2-chat" aria-label="Demo chat" aria-live="off">
          <div className="o2-chat-scroll">
            <div key={`${active.id}-${swapKey}`} className="o2-chat-feed">
              {visible.map((item, index) => (
                <ChatItem
                  key={`${active.id}-${index}`}
                  item={item}
                  elapsed={elapsed}
                  thread={active}
                />
              ))}
              {activity.running && !streaming && !toolBusy ? (
                <div className="o2-working">
                  <ProviderGlyph provider={active.provider} size={12} />
                  <span>Working…</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="o2-composer" aria-hidden="true">
            <span className="o2-composer-ph">
              {active.section === "needs"
                ? "Reply to the reviewer…"
                : "Ask for a follow-up. @ to mention files or threads"}
            </span>
            <div className="o2-composer-bar">
              <span className="o2-composer-btn">
                <PlusIcon />
              </span>
              <span className={`o2-model o2-tint-${active.provider}`}>
                <ProviderGlyph provider={active.provider} size={12} />
                {PROVIDER_NAME[active.provider]}
                <ChevronDown />
              </span>
              <span className="o2-composer-fill" />
              <span className="o2-composer-btn">
                <MicIcon />
              </span>
              <span
                className={
                  activity.running ? "o2-send o2-send--stop" : "o2-send"
                }
              >
                {activity.running ? <i /> : <ArrowUp />}
              </span>
            </div>
          </div>
        </section>

        <section
          className="o2-side"
          aria-label={`Demo ${active.panelLabel.toLowerCase()}`}
        >
          <div className="o2-side-tabs" aria-hidden="true">
            {(
              ["Preview", "Diff", "Terminal", "Browser", "Issues"] as const
            ).map((label) => (
              <span
                key={label}
                className={
                  label === active.panelLabel ? "o2-tab o2-tab--on" : "o2-tab"
                }
              >
                {label}
              </span>
            ))}
          </div>
          <div key={`${active.id}-${swapKey}`} className="o2-side-stage">
            <Panel thread={active} elapsed={elapsed} />
          </div>
        </section>
      </div>

      <footer className="o2-ws-foot" aria-hidden="true">
        <span className="o2-foot-tabs">
          <b>All 5</b>
          <span>Build 3</span>
          <span>Review 1</span>
          <span>Ops 1</span>
        </span>
        <span className="o2-foot-counts">
          <span>
            <i className="o2-dot o2-dot--run" />
            {counts.running} running
          </span>
          <span>
            <i className="o2-dot o2-dot--needs" />
            {counts.needs} needs you
          </span>
        </span>
        <span className="o2-foot-host">
          <i className="o2-dot o2-dot--ok" />
          Your server · connected
        </span>
      </footer>
    </div>
  );
}
