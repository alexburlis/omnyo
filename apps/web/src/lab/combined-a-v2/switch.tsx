import "./switch.css";

import {
  type CSSProperties,
  Fragment,
  type RefObject,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Mark } from "../open-5/page";
import { GUIDE_ONLY, IMPORTS } from "./content";
import { HarnessTile, harnessStyle } from "./harness-icons";

type Harness = (typeof IMPORTS)[number];

const IMPORT_NAMES = new Set<string>(IMPORTS.map((entry) => entry.name));

const GUIDES = GUIDE_ONLY.filter((guide) => !IMPORT_NAMES.has(guide.label));

const SOURCE_LIST = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
}).format(IMPORTS.map((entry) => entry.name));

const GUIDE_LIST = new Intl.ListFormat("en", {
  style: "long",
  type: "disjunction",
}).formatToParts(GUIDES.map((guide) => guide.label));

const LAND_MS = 1250;

const HOLD_MS = 2500;

const KEPT_ROWS = 7;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

interface Cycle {
  index: number;
  previous: number | null;
  seq: number;
  landed: boolean;
  manual: boolean;
  history: readonly number[];
}

type CycleAction =
  | { type: "advance" }
  | { type: "land" }
  | { type: "select"; index: number };

const INITIAL_CYCLE: Cycle = {
  index: 0,
  previous: null,
  seq: 0,
  landed: false,
  manual: false,
  history: [],
};

function moveTo(cycle: Cycle, index: number, manual: boolean): Cycle {
  return {
    ...cycle,
    index,
    previous: cycle.index,
    seq: cycle.seq + 1,
    landed: false,
    manual,
  };
}

function cycleReducer(cycle: Cycle, action: CycleAction): Cycle {
  switch (action.type) {
    case "advance":
      return moveTo(cycle, (cycle.index + 1) % IMPORTS.length, cycle.manual);
    case "land":
      return cycle.landed
        ? cycle
        : {
            ...cycle,
            landed: true,
            history: [
              cycle.index,
              ...cycle.history.filter((index) => index !== cycle.index),
            ],
          };
    case "select":
      return action.index === cycle.index && !cycle.landed
        ? cycle
        : moveTo(cycle, action.index, true);
  }
}

function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);

  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
}

function readReduced() {
  return window.matchMedia(REDUCED_MOTION).matches;
}

function useInView(ref: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const node = ref.current;

    if (node === null) return;

    let visible = false;

    const update = () => setActive(visible && !document.hidden);

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      update();
    });

    observer.observe(node);
    document.addEventListener("visibilitychange", update);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);

  return active;
}

function harnessAt(index: number): Harness {
  return IMPORTS[index] ?? IMPORTS[0];
}

function RollingName({
  entry,
  phase,
}: {
  entry: Harness;
  phase: "is-in" | "is-out" | "is-still";
}) {
  return (
    <span className={`switch-roll-name ${phase}`} style={harnessStyle(entry)}>
      <span className="switch-roll-char" style={{ "--i": 0 } as CSSProperties}>
        <HarnessTile className="switch-roll-tile" id={entry.id} />
      </span>
      {Array.from(entry.name).map((char, index) => (
        <span
          className="switch-roll-char"
          key={index}
          style={{ "--i": index + 1 } as CSSProperties}
        >
          {char === " " ? " " : char}
        </span>
      ))}
    </span>
  );
}

function SourceSwitcher({ cycle }: { cycle: Cycle }) {
  const current = harnessAt(cycle.index);
  const moved = cycle.previous !== null;

  return (
    <>
      <span className="switch-roll">
        {IMPORTS.map((entry) => (
          <span className="switch-roll-size" key={entry.id}>
            <HarnessTile className="switch-roll-tile" id={entry.id} />
            {entry.name}
          </span>
        ))}
        {cycle.previous !== null ? (
          <RollingName
            entry={harnessAt(cycle.previous)}
            key={cycle.seq - 1}
            phase="is-out"
          />
        ) : null}
        <RollingName
          entry={current}
          key={cycle.seq}
          phase={moved ? "is-in" : "is-still"}
        />
      </span>
      <span className="switch-roll-static">
        {IMPORTS.map((entry, index) => (
          <Fragment key={entry.id}>
            {index === 0 ? "" : index === IMPORTS.length - 1 ? " and " : ", "}
            <span className="switch-static-name" style={harnessStyle(entry)}>
              {entry.name}
            </span>
          </Fragment>
        ))}
      </span>
    </>
  );
}

function omnyoRows(history: readonly number[]) {
  return history
    .flatMap((index) => {
      const entry = harnessAt(index);

      return entry.chats.map((title, row) => ({
        key: `${entry.id}-${row}`,
        entry,
        title,
      }));
    })
    .slice(0, KEPT_ROWS);
}

function ImportStage({
  cycle,
  reduced,
  running,
  seen,
  onSelect,
}: {
  cycle: Cycle;
  reduced: boolean;
  running: boolean;
  seen: boolean;
  onSelect: (index: number) => void;
}) {
  const current = harnessAt(cycle.index);
  const landed = reduced || cycle.landed;

  const history = reduced
    ? [
        cycle.index,
        ...IMPORTS.map((_, index) => index).filter(
          (index) => index !== cycle.index,
        ),
      ]
    : cycle.history;

  const rows = omnyoRows(history);
  const fresh = new Set(landed ? rows.slice(0, 3).map((row) => row.key) : []);

  return (
    <div
      className={[
        "switch-stage",
        landed ? "is-landed" : "is-pending",
        running ? "is-running" : "",
        seen ? "is-seen" : "",
      ].join(" ")}
      style={harnessStyle(current)}
    >
      <div
        className="switch-picker"
        role="group"
        aria-label="Agents you can import from"
      >
        {IMPORTS.map((entry, index) => (
          <button
            aria-pressed={index === cycle.index}
            className="switch-chip"
            key={entry.id}
            onClick={() => onSelect(index)}
            style={harnessStyle(entry)}
            type="button"
          >
            <HarnessTile id={entry.id} />
            <span className="switch-chip-name">{entry.name}</span>
          </button>
        ))}
      </div>
      <div className="switch-pane switch-pane--source" aria-hidden="true">
        <div className="switch-pane-head" key={`head-${cycle.seq}`}>
          <HarnessTile id={current.id} />
          <span className="switch-pane-title">{current.name}</span>
          <span className="switch-pane-note">Recent chats</span>
        </div>
        <ul className="switch-source-rows" key={`rows-${cycle.seq}`}>
          {current.chats.map((title, row) => (
            <li
              className="switch-source-row"
              key={title}
              style={{ "--r": row } as CSSProperties}
            >
              <span className="switch-row-title">{title}</span>
              <span className="switch-row-check">
                <Check />
              </span>
            </li>
          ))}
        </ul>
        <span className="switch-import" key={`button-${cycle.seq}`}>
          <span className="switch-import-label switch-import-label--idle">
            Import to Omnyo
          </span>
          <span className="switch-import-label switch-import-label--done">
            <Check />
            Imported
          </span>
        </span>
      </div>
      <div className="switch-flow" aria-hidden="true">
        <span className="switch-flow-line" />
        <span className="switch-flow-dot" key={`dot-${cycle.seq}`} />
        <svg className="switch-flow-arrow" viewBox="0 0 16 16">
          <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
        </svg>
      </div>
      <div className="switch-pane switch-pane--omnyo" aria-hidden="true">
        <div className="switch-pane-head">
          <span className="switch-omnyo-mark">
            <Mark />
          </span>
          <span className="switch-pane-title">Omnyo</span>
          <span className="switch-pane-note">Every chat, one inbox</span>
        </div>
        {rows.length === 0 ? (
          <p className="switch-omnyo-empty">Imported chats land here</p>
        ) : null}
        <ul className="switch-omnyo-rows">
          {rows.map((row, slot) => (
            <li
              className="switch-omnyo-row"
              key={row.key}
              style={{ "--slot": slot } as CSSProperties}
            >
              <span
                className={
                  fresh.has(row.key)
                    ? "switch-omnyo-inner is-fresh"
                    : "switch-omnyo-inner"
                }
                style={
                  {
                    ...harnessStyle(row.entry),
                    "--r": slot,
                  } as CSSProperties
                }
              >
                <HarnessTile id={row.entry.id} />
                <span className="switch-row-title">{row.title}</span>
                <span className="switch-row-check">
                  <Check />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Check() {
  return (
    <svg className="switch-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function Switch() {
  const sectionRef = useRef<HTMLElement>(null);
  const [cycle, dispatch] = useReducer(cycleReducer, INITIAL_CYCLE);
  const inView = useInView(sectionRef);

  const reduced = useSyncExternalStore(
    subscribeReduced,
    readReduced,
    () => false,
  );

  const running = inView && !reduced;
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (running) setSeen(true);
  }, [running]);

  useEffect(() => {
    if (!running) return;

    if (!cycle.landed) {
      const timer = window.setTimeout(
        () => dispatch({ type: "land" }),
        LAND_MS,
      );

      return () => window.clearTimeout(timer);
    }

    if (cycle.manual) return;

    const timer = window.setTimeout(
      () => dispatch({ type: "advance" }),
      HOLD_MS,
    );

    return () => window.clearTimeout(timer);
  }, [running, cycle.seq, cycle.landed, cycle.manual]);

  return (
    <section
      className="band switch"
      data-flow
      data-progress="local"
      data-wipe="base"
      data-act="Switching"
      ref={sectionRef}
    >
      <header className="band-head">
        <p className="act-label">Switching</p>
        <h2 className="h2 switch-title">
          <span className="switch-sr">
            Import all your {SOURCE_LIST} chats in one click.
          </span>
          <span aria-hidden="true">
            Import all your <SourceSwitcher cycle={cycle} />
            <br />
            chats in one click.
          </span>
        </h2>
        <p className="body">
          Each chat continues with the agent&apos;s full context, and your
          original history is not changed.
        </p>
      </header>
      <ImportStage
        cycle={cycle}
        onSelect={(index) => dispatch({ type: "select", index })}
        reduced={reduced}
        running={running}
        seen={seen}
      />
      <p className="switch-more">
        <span>
          Coming from{" "}
          {GUIDE_LIST.map((part, index) => {
            if (part.type === "literal") {
              return <Fragment key={index}>{part.value}</Fragment>;
            }

            const guide = GUIDES.find((entry) => entry.label === part.value);

            return guide ? (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                {guide.label}
              </a>
            ) : null;
          })}
          ? Follow a step-by-step guide.
        </span>
        <a className="switch-more-link" href="/features/chat-import">
          How import works
          <span aria-hidden="true">→</span>
        </a>
      </p>
    </section>
  );
}

export { Switch };
