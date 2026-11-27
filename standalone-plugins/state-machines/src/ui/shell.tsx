import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useRealtimeConnectionState,
} from "@omnyo/plugin-sdk/app";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useQueryStore } from "./data/query.js";
import { formatClock } from "./primitives.js";
import { formatRoute, PANEL_PATH, type Route } from "./routes.js";

export type Go = (route: Route, options?: { replace?: boolean }) => void;

export function useGo(): Go {
  const navigate = experimental_useAppNavigate();

  return useCallback<Go>(
    (route, options) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: formatRoute(route),
        replace: options?.replace === true,
      });
    },
    [navigate],
  );
}

type Announce = (message: string) => void;

const AnnounceContext = createContext<Announce>(() => undefined);

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export function Announcer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const lastAt = useRef(0);
  const queued = useRef<string | null>(null);
  const timer = useRef<number | null>(null);

  const announce = useCallback<Announce>((next) => {
    const now = Date.now();
    const wait = Math.max(0, 2000 - (now - lastAt.current));

    queued.current = next;

    if (timer.current !== null) return;

    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      setMessage(queued.current ?? "");
      queued.current = null;
    }, wait);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="stm-sr-only" aria-live="polite" role="status">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export type MachineTab = "overview" | "draft" | "versions" | "settings";

export function shortId(id: string): string {
  const body = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;

  return body.slice(0, 8);
}

export function MachineTabs({ machineId, active }: { machineId: string; active: MachineTab }) {
  const go = useGo();

  const tabs: { key: MachineTab; label: string; route: Route }[] = [
    { key: "overview", label: "Overview", route: { screen: "machine", machineId } },
    { key: "draft", label: "Edit draft", route: { screen: "draft", machineId, selection: null } },
    { key: "versions", label: "Versions", route: { screen: "versions", machineId } },
    { key: "settings", label: "Settings", route: { screen: "settings", machineId } },
  ];

  return (
    <nav className="stm-tabs" aria-label="Machine sections">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className="stm-tab"
          aria-current={tab.key === active ? "page" : undefined}
          onClick={() => tab.key !== active && go(tab.route)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function FloatingPanel({
  label,
  onClose,
  flushTop = false,
  children,
}: {
  label: string;
  onClose(): void;
  flushTop?: boolean;
  children: ReactNode;
}) {
  return (
    <aside
      className={`stm-floating-panel${flushTop ? " stm-floating-panel--flush-top" : ""}`}
      aria-label={label}
    >
      <button
        type="button"
        className="stm-tool stm-floating-close"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={onClose}
      >
        <Icon name="X" fallback="CircleX" aria-hidden />
      </button>
      {children}
    </aside>
  );
}

export interface Crumb {
  label: string;
  route: Route | null;
}

export function Page({
  crumbs,
  title,
  titleExtra,
  actions,
  statusLine,
  banner,
  tabs,
  children,
  flush = false,
}: {
  crumbs: Crumb[];
  title: ReactNode;
  titleExtra?: ReactNode;
  actions?: ReactNode;
  statusLine?: ReactNode;
  banner?: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  const go = useGo();

  return (
    <section
      className={`stm-page${flush ? " stm-page--flush" : ""}`}
      aria-labelledby="stm-page-title"
    >
      {crumbs.length < 2 ? null : (
        <nav className="stm-breadcrumb" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((crumb, index) => (
              <li key={`${crumb.label}:${index}`}>
                {crumb.route === null || index === crumbs.length - 1 ? (
                  <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                    {crumb.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="stm-link"
                    onClick={() => crumb.route !== null && go(crumb.route)}
                  >
                    {crumb.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <header className="stm-page-header">
        <div className="stm-page-heading">
          <h1 id="stm-page-title" className="stm-h1">
            {title}
          </h1>
          {titleExtra}
        </div>
        {actions === undefined ? null : <div className="stm-row stm-page-actions">{actions}</div>}
      </header>
      {tabs}
      {statusLine === undefined ? null : <div className="stm-status-line">{statusLine}</div>}
      <ReconnectBanner />
      {banner}
      <div className="stm-page-body">{children}</div>
    </section>
  );
}

export function ReconnectBanner() {
  const connection = useRealtimeConnectionState();
  const store = useQueryStore();
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  useEffect(() => store.onAnyChange(() => setLastUpdate(Date.now())), [store]);

  if (connection !== "reconnecting") return null;

  return (
    <div className="stm-reconnect" role="status">
      Reconnecting… Live status may be out of date.
      {lastUpdate === null ? "" : ` Last update ${formatClock(lastUpdate)}.`}
    </div>
  );
}

export function useConnectionFrozen(): boolean {
  return useRealtimeConnectionState() === "reconnecting";
}
