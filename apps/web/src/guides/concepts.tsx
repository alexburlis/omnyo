import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import ArrowTurnForwardIcon from "@hugeicons/core-free-icons/ArrowTurnForwardIcon";
import BubbleChatAddIcon from "@hugeicons/core-free-icons/BubbleChatAddIcon";
import CalendarCheckOut02Icon from "@hugeicons/core-free-icons/CalendarCheckOut02Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import DateTimeIcon from "@hugeicons/core-free-icons/DateTimeIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import InternetIcon from "@hugeicons/core-free-icons/InternetIcon";
import LinkSquare02Icon from "@hugeicons/core-free-icons/LinkSquare02Icon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import PaintbrushIcon from "@hugeicons/core-free-icons/PaintbrushIcon";
import PlusMinusSquare01Icon from "@hugeicons/core-free-icons/PlusMinusSquare01Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties } from "react";

import conductorIcon from "../assets/competitors/conductor.png";
import cursorIcon from "../assets/competitors/cursor.png";
import supersetIcon from "../assets/competitors/superset.png";
import t3CodeIcon from "../assets/competitors/t3-code.png";
import vibeKanbanIcon from "../assets/competitors/vibe-kanban.png";
import {
  BrandMark,
  SidebarRow,
  WorkingGlyph,
} from "../compare/compare-visuals";
import { AnywhereVisual } from "../compare/phone";
import { ClaudeIcon, OpenAiIcon } from "../landing/icons";

const SERVERS = [
  { branch: "feat/search-highlight", port: 5173 },
  { branch: "main", port: 5174 },
  { branch: "fix/login-redirect", port: 5175 },
];

const MACHINE = "devbox";

function delay(index: number): CSSProperties {
  return { animationDelay: `${index * 1.1}s` };
}

export function RemoteServersConcept() {
  return (
    <div
      className="gd-diagram"
      role="img"
      aria-label="Three branches on devbox, each with its own dev server. Each one opens from the thread's Dev servers shelf, privately through Omnyo."
    >
      <div className="gd-card">
        <div className="gd-card-head">
          <span className="gd-card-title">
            <span className="gd-live" />
            {MACHINE}
          </span>
          <span className="gd-card-detail">Online</span>
        </div>
        {SERVERS.map((server) => (
          <div key={server.port} className="gd-row">
            <span className="gd-branch">
              <HugeiconsIcon icon={GitBranchIcon} className="gd-ic" />
              {server.branch}
            </span>
            <span className="gd-cmd">pnpm dev --port {server.port}</span>
            <span className="gd-port">:{server.port}</span>
          </div>
        ))}
      </div>
      <div className="gd-wires" aria-hidden="true">
        {SERVERS.map((server, index) => (
          <span
            key={server.port}
            className="gd-wire"
            style={{ top: `${76 + index * 48}px`, ...delay(index) }}
          />
        ))}
      </div>
      <div className="gd-card">
        <div className="gd-card-head">
          <span className="gd-card-title">
            <span className="omnyo-mark" />
            Dev servers
          </span>
          <span className="gd-lock">
            <HugeiconsIcon icon={LockIcon} className="gd-ic" />
            Opens privately through Omnyo
          </span>
        </div>
        {SERVERS.map((server, index) => (
          <div
            key={server.port}
            className="gd-row gd-link"
            style={delay(index)}
          >
            <span className="gd-server-dot" />
            <span className="gd-url">
              localhost:<b>{server.port}</b>
            </span>
            <span className="gd-server-status">Running · {MACHINE}</span>
            <span className="gd-server-open">Open</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnywhereConcept() {
  return (
    <div className="gd-anywhere">
      <AnywhereVisual />
    </div>
  );
}

type SwitchFrom =
  | { id: string; name: string; src: string }
  | { id: string; name: string; glyph: typeof ClaudeIcon; tone: string };

const SWITCH_FROM: SwitchFrom[] = [
  {
    id: "claude",
    name: "Claude Code",
    glyph: ClaudeIcon,
    tone: "gd-switch-glyph-claude",
  },
  { id: "codex-app", name: "Codex", glyph: OpenAiIcon, tone: "" },
  { id: "conductor", name: "Conductor", src: conductorIcon },
  { id: "cursor", name: "Cursor", src: cursorIcon },
  { id: "superset", name: "Superset", src: supersetIcon },
  { id: "t3-code", name: "T3 Code", src: t3CodeIcon },
  { id: "vibe-kanban", name: "Vibe Kanban", src: vibeKanbanIcon },
];

export function SwitchConcept({ tool }: { tool: string }) {
  return (
    <div className="cmp-logos gd-switch">
      {SWITCH_FROM.filter((item) => item.id === tool).map((item) => (
        <span key={item.id} className="cmp-logo-item">
          {"glyph" in item ? (
            <span
              aria-hidden="true"
              className={`cmp-logo gd-switch-glyph ${item.tone}`}
            >
              <item.glyph className="gd-switch-glyph-ic" />
            </span>
          ) : (
            <BrandMark
              logo={{ kind: "image", src: item.src }}
              className="cmp-logo"
            />
          )}
          <span className="gd-switch-name">{item.name}</span>
        </span>
      ))}
      <HugeiconsIcon icon={ArrowRight01Icon} className="gd-switch-arrow" />
      <span className="cmp-logo-item">
        <BrandMark logo={{ kind: "omnyo" }} className="cmp-logo" />
        <span className="gd-switch-name">Omnyo</span>
      </span>
    </div>
  );
}

const SKIPPED_RUNS = [
  { time: "9:00 AM", duration: "0.3s" },
  { time: "9:15 AM", duration: "0.2s" },
];

export function ScheduleConcept() {
  return (
    <div
      className="gd-sched"
      role="img"
      aria-label="A script automation checks CI every 15 minutes. The 9:00 and 9:15 runs find nothing and are skipped. At 9:30 it finds a failed run and starts a Codex thread to fix it, which appears in the sidebar."
    >
      <div className="gd-card gd-sched-auto">
        <div className="gd-card-head">
          <span className="gd-card-title">
            <HugeiconsIcon
              icon={ComputerTerminal01Icon}
              className="gd-sched-ic"
            />
            CI failure check
          </span>
          <span className="gd-sched-toggle" />
        </div>
        <div className="gd-sched-meta">
          <HugeiconsIcon icon={Folder01Icon} className="gd-sched-ic" />
          acme-web
          <span aria-hidden="true">·</span>
          <HugeiconsIcon icon={DateTimeIcon} className="gd-sched-ic" />
          Every 15 min
          <span aria-hidden="true">·</span>
          <HugeiconsIcon
            icon={CalendarCheckOut02Icon}
            className="gd-sched-ic"
          />
          Nov 14, 9:45 AM
        </div>
        <div className="gd-sched-label">Runs</div>
        {SKIPPED_RUNS.map((run) => (
          <div key={run.time} className="gd-sched-run">
            <div className="gd-sched-run-head">
              <HugeiconsIcon
                icon={ArrowTurnForwardIcon}
                className="gd-sched-ic"
              />
              <span className="gd-sched-time">Nov 14, {run.time}</span>
              <span className="gd-sched-note">
                {run.duration} · empty output
              </span>
            </div>
          </div>
        ))}
        <div className="gd-sched-run">
          <div className="gd-sched-run-head">
            <span className="gd-sched-swap gd-sched-ic">
              <span className="gd-sched-before gd-sched-pending" />
              <span className="gd-sched-after">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  className="gd-sched-ic gd-sched-ok"
                />
              </span>
            </span>
            <span className="gd-sched-time">Nov 14, 9:30 AM</span>
            <span className="gd-sched-swap gd-sched-note">
              <span className="gd-sched-before">Running…</span>
              <span className="gd-sched-after">0.4s</span>
            </span>
          </div>
          <div className="gd-sched-output gd-sched-swap">
            <span className="gd-sched-before">
              Checking main for failed CI runs…
            </span>
            <span className="gd-sched-after">
              CI failed on main. Started a Codex thread.
            </span>
          </div>
        </div>
      </div>
      <div className="gd-sched-wire" aria-hidden="true">
        <span className="gd-sched-dot" />
      </div>
      <div className="gd-sched-swap gd-sched-thread-slot">
        <div className="gd-sched-before gd-sched-thread gd-sched-ghost">
          <div className="gd-sched-thread-title">No agent running</div>
          <div className="gd-sched-thread-status">
            Starts only when the script finds work
          </div>
        </div>
        <div className="gd-sched-after gd-card gd-sched-thread gd-sched-side">
          <div className="cmp-side-label">Threads</div>
          <ul className="cmp-rows">
            <SidebarRow
              selected
              provider={OpenAiIcon}
              title="Fix CI on main"
              glyph={<WorkingGlyph />}
              age="now"
              working
            />
          </ul>
        </div>
      </div>
    </div>
  );
}

const BROWSER_SCENES = {
  code: {
    url: "http://localhost:5173/orders",
    secure: false,
    label:
      "Omnyo's Browser tab with Browser Automation controlling a local app. The order search box is pinned with the comment: Keep the search box visible on phones.",
    title: "Orders",
    rows: [
      "#1042 · Maya Chen · $128.00",
      "#1041 · Jonas Weber · $54.50",
      "#1040 · Priya Natarajan · $212.40",
    ],
    target: "Search orders",
    tag: "input",
    comment: "Keep the search box visible on phones.",
  },
  work: {
    url: "https://billing.vendor.com/invoices",
    secure: true,
    label:
      "Omnyo's Browser tab with Browser Automation controlling a signed-in billing site. The quarter's invoice total is pinned with the comment: Add this to the quarterly spend sheet.",
    title: "Invoices",
    rows: ["July · $1,240.00", "August · $1,315.50", "September · $1,402.75"],
    target: "Total · $3,958.25",
    tag: "td",
    comment: "Add this to the quarterly spend sheet.",
  },
};

export function BrowserConcept({ scene }: { scene: "code" | "work" }) {
  const view = BROWSER_SCENES[scene];

  return (
    <div className="gd-btab" role="img" aria-label={view.label}>
      <div className="gd-btab-tabs" aria-hidden="true">
        <span className="gd-btab-tab gd-btab-tab-icon">
          <HugeiconsIcon icon={InformationCircleIcon} className="gd-btab-ic" />
        </span>
        <span className="gd-btab-tab gd-btab-tab-icon">
          <HugeiconsIcon icon={PlusMinusSquare01Icon} className="gd-btab-ic" />
        </span>
        <span className="gd-btab-tab gd-btab-tab-on">
          <HugeiconsIcon icon={InternetIcon} className="gd-btab-ic" />
          {view.title}
        </span>
        <span className="gd-btab-tab gd-btab-tab-icon">
          <HugeiconsIcon icon={PlusSignIcon} className="gd-btab-ic" />
        </span>
      </div>
      <div className="gd-btab-bar" aria-hidden="true">
        <HugeiconsIcon icon={ArrowLeft01Icon} className="gd-btab-ic" />
        <HugeiconsIcon icon={ArrowRight01Icon} className="gd-btab-ic" />
        <HugeiconsIcon icon={Refresh01Icon} className="gd-btab-ic" />
        <span className="gd-btab-url">
          <HugeiconsIcon
            icon={view.secure ? LockIcon : Alert02Icon}
            className={
              view.secure
                ? "gd-btab-ic gd-btab-secure"
                : "gd-btab-ic gd-btab-insecure"
            }
          />
          <span className="gd-btab-url-text">{view.url}</span>
        </span>
        <span className="gd-btab-annotate">
          <HugeiconsIcon icon={BubbleChatAddIcon} className="gd-btab-ic" />
          <span className="gd-btab-badge">1</span>
        </span>
        <HugeiconsIcon icon={PaintbrushIcon} className="gd-btab-ic" />
        <HugeiconsIcon icon={LinkSquare02Icon} className="gd-btab-ic" />
      </div>
      <div className="gd-btab-control" aria-hidden="true">
        <span>Browser Automation is controlling this tab</span>
        <span className="gd-btab-action">Stop</span>
        <span className="gd-btab-action">Take over</span>
      </div>
      <div className="gd-btab-page" aria-hidden="true">
        <div className="gd-btab-page-head">
          <strong>{view.title}</strong>
          <span className="gd-btab-target">
            {view.target}
            <span className="gd-browser-pin gd-btab-pin">1</span>
          </span>
        </div>
        {view.rows.map((row) => (
          <div key={row} className="gd-btab-row">
            {row}
          </div>
        ))}
        <div className="gd-btab-note">
          <div className="gd-btab-note-target">
            <span className="gd-btab-tag">{view.tag}</span>
            {view.target}
          </div>
          <div className="gd-btab-note-text">{view.comment}</div>
          <div className="gd-btab-note-actions">
            <span className="gd-btab-action">Cancel</span>
            <span className="gd-btab-save">Add to prompt</span>
          </div>
        </div>
      </div>
    </div>
  );
}
