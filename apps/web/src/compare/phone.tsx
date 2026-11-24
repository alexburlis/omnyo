import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import BubbleChatAddIcon from "@hugeicons/core-free-icons/BubbleChatAddIcon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import LaptopIcon from "@hugeicons/core-free-icons/LaptopIcon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Plug02Icon from "@hugeicons/core-free-icons/Plug02Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import RepeatIcon from "@hugeicons/core-free-icons/RepeatIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import ZapIcon from "@hugeicons/core-free-icons/ZapIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";

import { ClaudeIcon, OpenAiIcon } from "../landing/icons";
import { InboxGlyph } from "./compare-visuals";

const BEZEL = 16.6;

type PhoneScreen = { width: number; height: number };

const IPHONE: PhoneScreen = { width: 402, height: 874 };

export function PhoneFrame({
  screen = IPHONE,
  capture,
  children,
}: {
  screen?: PhoneScreen;
  capture?: boolean;
  children: ReactNode;
}) {
  const unit = screen.width + BEZEL * 2;

  return (
    <div
      className="ph"
      style={{ "--ph-u": unit, "--ph-bezel": BEZEL } as CSSProperties}
    >
      <span className="ph-btn ph-btn-action" />
      <span className="ph-btn ph-btn-up" />
      <span className="ph-btn ph-btn-down" />
      <span className="ph-btn ph-btn-side" />
      <div
        className="ph-body"
        style={{ aspectRatio: `${unit} / ${screen.height + BEZEL * 2}` }}
      >
        <div className={capture ? "ph-screen ph-capture" : "ph-screen"}>
          {children}
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <>
      <span className="ph-status">
        <span className="ph-time">9:41</span>
        <span className="ph-sys">
          <svg viewBox="0 0 18 12">
            <rect y="8" width="3" height="4" rx="0.8" />
            <rect x="5" y="5.5" width="3" height="6.5" rx="0.8" />
            <rect x="10" y="3" width="3" height="9" rx="0.8" />
            <rect x="15" width="3" height="12" rx="0.8" />
          </svg>
          <svg viewBox="0 0 17 12">
            <path d="M8.5 2.6c2.3 0 4.4.9 6 2.4.1.1.3.1.4 0l1-1c.1-.1.1-.3 0-.5C13.9 1.6 11.3.5 8.5.5S3.1 1.6 1.1 3.5c-.1.1-.1.3 0 .5l1 1c.1.1.3.1.4 0 1.6-1.5 3.7-2.4 6-2.4Z" />
            <path d="M8.5 6.4c1.3 0 2.4.5 3.3 1.3.1.1.3.1.4 0l1-1c.1-.1.1-.3 0-.5-1.3-1.2-2.9-1.9-4.7-1.9s-3.4.7-4.7 1.9c-.1.1-.1.3 0 .5l1 1c.1.1.3.1.4 0 .9-.8 2-1.3 3.3-1.3Z" />
            <path d="M11.1 9.1c.1.1.1.3 0 .4l-2.4 2.4c-.1.1-.3.1-.4 0L5.9 9.5c-.1-.1-.1-.3 0-.4.7-.6 1.6-1 2.6-1s1.9.4 2.6 1Z" />
          </svg>
          <svg viewBox="0 0 27 12.4">
            <rect
              x="0.5"
              y="0.5"
              width="23"
              height="11.4"
              rx="3.6"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.4"
            />
            <rect x="2" y="2" width="20" height="8.4" rx="2.2" />
            <path
              d="M25 4.2c.9.3 1.5 1.1 1.5 2s-.6 1.7-1.5 2Z"
              fillOpacity="0.45"
            />
          </svg>
        </span>
      </span>
      <span className="ph-island" />
      <span className="ph-home" />
    </>
  );
}

type Provider = typeof ClaudeIcon;

type Thread = {
  title: string;
  provider: Provider;
  age: string;
  state: "working" | "needs" | "done";
  workingChildren?: number;
  unread?: boolean;
  child?: boolean;
  subtitle?: string;
};

const QUESTION = "Add a dark mode toggle";

const THREADS: Thread[] = [
  {
    title: "Rate-limit uploads",
    provider: ClaudeIcon,
    age: "now",
    state: "working",
    workingChildren: 1,
  },
  {
    title: "Review: Rate-limit uploads",
    provider: OpenAiIcon,
    age: "now",
    state: "working",
    child: true,
  },
  {
    title: QUESTION,
    provider: ClaudeIcon,
    age: "2h ago",
    state: "needs",
    unread: true,
    subtitle: "Needs you: header or Settings?",
  },
  {
    title: "Issue triage",
    provider: OpenAiIcon,
    age: "1h ago",
    state: "done",
    unread: true,
  },
  {
    title: "Fix emoji filenames",
    provider: ClaudeIcon,
    age: "3h ago",
    state: "done",
  },
  {
    title: "Resumable uploads",
    provider: ClaudeIcon,
    age: "4h ago",
    state: "done",
  },
  {
    title: "Speed up CI",
    provider: ClaudeIcon,
    age: "5h ago",
    state: "done",
  },
  {
    title: "Cache search results",
    provider: OpenAiIcon,
    age: "2d ago",
    state: "done",
  },
  {
    title: "Bump dependencies",
    provider: ClaudeIcon,
    age: "3d ago",
    state: "done",
  },
];

function StateGlyph({ thread }: { thread: Thread }) {
  if (thread.state === "working") {
    return thread.workingChildren ? (
      <span className="ph-ring">{thread.workingChildren}</span>
    ) : (
      <span className="ph-orb" />
    );
  }

  if (thread.state === "needs") {
    return <HugeiconsIcon icon={HelpCircleIcon} className="ph-glyph-needs" />;
  }

  return (
    <HugeiconsIcon icon={CheckmarkCircle02Icon} className="ph-glyph-done" />
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const classes = ["ph-row", `ph-row-${thread.state}`];

  if (thread.workingChildren) classes.push("ph-row-parent");

  if (thread.child) classes.push("ph-row-kid");

  if (thread.unread) classes.push("ph-row-unread");

  const ProviderIcon = thread.provider;

  return (
    <li className={classes.join(" ")}>
      <span className="ph-row-line">
        <span className="ph-row-glyph">
          <StateGlyph thread={thread} />
        </span>
        <ProviderIcon className="ph-row-prov" />
        <span className="ph-row-title">{thread.title}</span>
        <span className="ph-row-age">{thread.age}</span>
      </span>
      {thread.subtitle ? (
        <span className="ph-row-sub">{thread.subtitle}</span>
      ) : null}
    </li>
  );
}

function ThreadList() {
  return (
    <div className="ph-app">
      <div className="ph-drawer">
        <div className="ph-rail">
          <span className="ph-tile ph-tile-inbox ph-tile-on">
            <InboxGlyph />
            <span className="ph-count">1</span>
            <span className="ph-running" />
          </span>
          <span className="ph-tile">
            <span className="ph-face" style={{ "--hue": 250 } as CSSProperties}>
              aw
            </span>
            <span className="ph-count">1</span>
            <span className="ph-running" />
          </span>
          <span className="ph-tile">
            <span className="ph-face" style={{ "--hue": 305 } as CSSProperties}>
              aa
            </span>
          </span>
          <span className="ph-tile">
            <span className="ph-face ph-face-add">
              <HugeiconsIcon icon={PlusSignIcon} />
            </span>
          </span>
          <span className="ph-rail-fill" />
          {[MoreHorizontalIcon, RepeatIcon, ZapIcon, Plug02Icon].map(
            (icon, index) => (
              <span key={index} className="ph-rail-ic">
                <HugeiconsIcon icon={icon} />
              </span>
            ),
          )}
        </div>
        <div className="ph-list">
          <div className="ph-list-head">
            <span className="ph-new">
              <HugeiconsIcon icon={BubbleChatAddIcon} />
              New thread
            </span>
            <span className="ph-nav">
              <HugeiconsIcon icon={ArrowLeft01Icon} />
              <HugeiconsIcon icon={ArrowRight01Icon} />
            </span>
          </div>
          <div className="ph-section">
            Threads
            <HugeiconsIcon icon={ArrowDown01Icon} />
            <HugeiconsIcon icon={BubbleChatAddIcon} />
            <HugeiconsIcon icon={MoreHorizontalIcon} />
          </div>
          <ul className="ph-rows">
            {THREADS.map((thread) => (
              <ThreadRow key={thread.title} thread={thread} />
            ))}
          </ul>
        </div>
        <div className="ph-foot">
          <span>
            <HugeiconsIcon icon={Settings01Icon} />
          </span>
          <span>
            <HugeiconsIcon icon={MoreHorizontalIcon} />
          </span>
        </div>
      </div>
      <div className="ph-peek">
        <span className="ph-peek-card">
          <HugeiconsIcon icon={PlusSignIcon} />
        </span>
      </div>
    </div>
  );
}

const MACHINES = [
  {
    name: "MacBook Pro",
    badge: "server",
    platform: "macOS",
    projects: "2 projects",
  },
  { name: "devbox", badge: null, platform: null, projects: "1 project" },
] as const;

function MachinesCard() {
  return (
    <div className="ph-machines">
      <span className="ph-flow">
        <i />
        <i />
      </span>
      <span className="ph-machines-title">Machines</span>
      {MACHINES.map((machine, index) => (
        <span key={machine.name} className="ph-machine">
          <span className="ph-machine-name">
            <HugeiconsIcon icon={LaptopIcon} />
            {machine.name}
            {machine.badge ? (
              <span className="ph-badge">{machine.badge}</span>
            ) : null}
          </span>
          <span className="ph-machine-meta">
            <span>
              <span
                className="ph-machine-dot"
                style={{ animationDelay: `${index * 1.1}s` }}
              />
              Online
            </span>
            {machine.platform ? <span>{machine.platform}</span> : null}
            <span>{machine.projects}</span>
            <span>Approve for me</span>
          </span>
        </span>
      ))}
    </div>
  );
}

function PushNote() {
  return (
    <div className="ph-note">
      <span className="omnyo-mark ph-note-icon" />
      <span className="ph-note-body">
        <span className="ph-note-top">
          <span className="ph-note-title">{QUESTION}</span>
          <span className="ph-note-time">now</span>
        </span>
        <span className="ph-note-text">
          Where should the toggle go: the header or Settings?
        </span>
      </span>
    </div>
  );
}

export function AnywhereVisual() {
  return (
    <div
      className="ph-scene"
      role="img"
      aria-label="Omnyo on an iPhone, showing the thread list: one thread and its review are working, one needs an answer, and the rest are finished. Beside the phone are the push notification with that question and the Machines list, with two machines online."
    >
      <PushNote />
      <PhoneFrame>
        <ThreadList />
        <StatusBar />
      </PhoneFrame>
      <MachinesCard />
    </div>
  );
}
