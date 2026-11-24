import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import BubbleChatAddIcon from "@hugeicons/core-free-icons/BubbleChatAddIcon";
import BubbleChatIcon from "@hugeicons/core-free-icons/BubbleChatIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import ExpandIcon from "@hugeicons/core-free-icons/ExpandIcon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import Mic02Icon from "@hugeicons/core-free-icons/Mic02Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Plug02Icon from "@hugeicons/core-free-icons/Plug02Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import RepeatIcon from "@hugeicons/core-free-icons/RepeatIcon";
import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import ShieldUserIcon from "@hugeicons/core-free-icons/ShieldUserIcon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import ZapIcon from "@hugeicons/core-free-icons/ZapIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";

import { ClaudeIcon, OpenAiIcon } from "../landing/icons";
import { useCycle } from "../landing/landing-visuals";

export type BrandLogo = { kind: "omnyo" } | { kind: "image"; src: string };

export function BrandMark({
  logo,
  className,
}: {
  logo: BrandLogo;
  className: string;
}) {
  if (logo.kind === "omnyo") {
    return <span aria-hidden="true" className={`omnyo-mark ${className}`} />;
  }

  return <img src={logo.src} alt="" className={className} />;
}

type Provider = typeof ClaudeIcon;

type Phase = { at: number; node: ReactNode };

function Phases({ steps }: { steps: Phase[] }) {
  return (
    <span className="cmp-phases">
      {steps.map((step, index) => {
        const next = steps[index + 1];

        const style = {
          "--in": `${step.at}s`,
          "--out": next ? `${next.at}s` : "9999s",
        } as CSSProperties;

        return (
          <span key={step.at} className="cmp-phase" style={style}>
            {step.node}
          </span>
        );
      })}
    </span>
  );
}

export function WorkingGlyph({ count }: { count?: number }) {
  if (!count) {
    return <span className="cmp-orb" />;
  }

  return (
    <span className="cmp-spin-count">
      <span className="cmp-spin-track" />
      <span className="cmp-spin-arc" />
      {count}
    </span>
  );
}

function NeedsYouGlyph() {
  return <HugeiconsIcon icon={HelpCircleIcon} className="cmp-glyph-needs" />;
}

function ReadyGlyph() {
  return (
    <HugeiconsIcon icon={CheckmarkCircle02Icon} className="cmp-glyph-ready" />
  );
}

export function SidebarRow({
  glyph,
  provider: ProviderIcon,
  title,
  age,
  subtitle,
  kid,
  parent,
  selected,
  bold,
  working,
  className,
  style,
}: {
  glyph?: ReactNode;
  provider: Provider;
  title: string;
  age: string;
  subtitle?: ReactNode;
  kid?: boolean;
  parent?: boolean;
  selected?: boolean;
  bold?: boolean;
  working?: true | { from: number; until: number };
  className?: string;
  style?: CSSProperties;
}) {
  const classes = ["cmp-row"];

  if (working !== undefined) classes.push("cmp-row-working");

  if (typeof working === "object") classes.push("cmp-row-working-ends");

  if (kid) classes.push("cmp-row-kid");

  if (parent) classes.push("cmp-row-parent");

  if (selected) classes.push("cmp-row-on");

  if (bold) classes.push("cmp-row-unread");

  if (className) classes.push(className);

  const rowStyle =
    typeof working === "object"
      ? ({
          ...style,
          "--working-in": `${working.from}s`,
          "--working-out": `${working.until}s`,
        } as CSSProperties)
      : style;

  return (
    <li className={classes.join(" ")} style={rowStyle}>
      <span className="cmp-row-line">
        <span className="cmp-row-glyph">{glyph}</span>
        <ProviderIcon className="cmp-row-prov" />
        <span className="cmp-row-title">{title}</span>
        <span className="cmp-row-age">{age}</span>
      </span>
      {subtitle ? <span className="cmp-row-sub">{subtitle}</span> : null}
    </li>
  );
}

const INBOX_OUTLINE =
  "M3.25 10.6v7.15A3.25 3.25 0 0 0 6.5 21h11a3.25 3.25 0 0 0 3.25-3.25V10.6a2 2 0 0 0-.74-1.55l-6.74-5.53a2 2 0 0 0-2.54 0L3.99 9.05a2 2 0 0 0-.74 1.55Z";

const INBOX_TRAY = "M3.25 13.75h5.6l1.25 2.5h3.8l1.25-2.5h5.6";

export function InboxGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="cmp-rail-inbox"
    >
      <path
        d={INBOX_OUTLINE}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="none"
      />
      <path
        d={`${INBOX_TRAY}v4A3.25 3.25 0 0 1 17.5 21h-11a3.25 3.25 0 0 1-3.25-3.25Z`}
        fill="currentColor"
        fillOpacity={0.34}
        stroke="none"
      />
      <path d={INBOX_OUTLINE} />
      <path d={INBOX_TRAY} />
    </svg>
  );
}

function NavRail({
  running: { from, until },
  needs,
}: {
  running: { from: number; until: number };
  needs: number;
}) {
  const running = (
    <span
      className="cmp-rail-running cmp-rail-running-timed"
      style={{ "--in": `${from}s`, "--out": `${until}s` } as CSSProperties}
    />
  );

  const badge = <span className="cmp-rail-count">{needs}</span>;

  return (
    <span className="cmp-rail" aria-hidden="true">
      <span className="cmp-rail-tile">
        <InboxGlyph />
        {badge}
        {running}
      </span>
      <span className="cmp-rail-tile cmp-rail-tile-on">
        <span className="cmp-rail-face">aw</span>
        {badge}
        {running}
      </span>
      <span className="cmp-rail-fill" />
      <HugeiconsIcon icon={MoreHorizontalIcon} className="cmp-rail-ic" />
      <HugeiconsIcon icon={RepeatIcon} className="cmp-rail-ic" />
      <HugeiconsIcon icon={ZapIcon} className="cmp-rail-ic" />
      <HugeiconsIcon icon={Plug02Icon} className="cmp-rail-ic" />
    </span>
  );
}

function AppFooter() {
  return (
    <span className="cmp-footer" aria-hidden="true">
      <span className="cmp-footer-gear">
        <HugeiconsIcon icon={Settings01Icon} className="cmp-rail-ic" />
      </span>
    </span>
  );
}

function NewThreadButton() {
  return (
    <span className="cmp-new-thread">
      <HugeiconsIcon icon={BubbleChatAddIcon} className="cmp-new-thread-ic" />
      New thread
    </span>
  );
}

function ThreadPill({ title }: { title: string }) {
  return (
    <span className="cmp-pill">
      <HugeiconsIcon icon={UserIcon} className="cmp-pill-ic" />
      {title}
    </span>
  );
}

function PaneHead({
  title,
  focused,
  closable,
}: {
  title: string;
  focused?: boolean;
  closable?: boolean;
}) {
  return (
    <div className="cmp-pane-head">
      <span
        className={
          focused ? "cmp-pane-title cmp-pane-title-on" : "cmp-pane-title"
        }
      >
        {title}
      </span>
      {closable ? (
        <span className="cmp-pane-tools" aria-hidden="true">
          <HugeiconsIcon icon={ExpandIcon} className="cmp-pane-tool" />
          <HugeiconsIcon icon={Cancel01Icon} className="cmp-pane-tool" />
        </span>
      ) : null}
    </div>
  );
}

function ComposerRow({
  provider: ProviderIcon,
  model,
  effort,
  pulse,
}: {
  provider: Provider;
  model: string;
  effort: string;
  pulse?: boolean;
}) {
  return (
    <span className="cmp-composer-row" aria-hidden="true">
      <span className="cmp-tool">
        <HugeiconsIcon icon={PlusSignIcon} className="cmp-tool-ic" />
      </span>
      <span className="cmp-model">
        <ProviderIcon className="cmp-model-ic" />
        {model}
        <span className="cmp-model-effort">{effort}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} className="cmp-model-chev" />
      </span>
      <span className="cmp-composer-end">
        <span className="cmp-tool">
          <HugeiconsIcon icon={ShieldUserIcon} className="cmp-tool-ic" />
        </span>
        <span className="cmp-tool">
          <HugeiconsIcon icon={Mic02Icon} className="cmp-tool-ic" />
        </span>
        <span className={pulse ? "cmp-send cmp-send-pulse" : "cmp-send"}>
          <HugeiconsIcon icon={ArrowUp02Icon} className="cmp-send-ic" />
          <HugeiconsIcon icon={ArrowDown01Icon} className="cmp-send-chev" />
        </span>
      </span>
    </span>
  );
}

function FinishedRow({
  thread,
  delay,
  children,
}: {
  thread: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <li className="cmp-message" style={{ animationDelay: `${delay}s` }}>
      <span className="cmp-message-head">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="cmp-message-ic"
        />
        <ThreadPill title={thread} />
        <span className="cmp-message-label">finished</span>
      </span>
      <span className="cmp-message-body">{children}</span>
    </li>
  );
}

function TimelineMessage({
  label,
  thread,
  delay,
  children,
}: {
  label: "Message from" | "Sent to";
  thread: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <li className="cmp-message" style={{ animationDelay: `${delay}s` }}>
      <span className="cmp-message-head">
        <HugeiconsIcon
          icon={label === "Sent to" ? SentIcon : BubbleChatIcon}
          className="cmp-message-ic"
        />
        <span className="cmp-message-label">{label}</span>
        <ThreadPill title={thread} />
      </span>
      <span className="cmp-message-body">{children}</span>
    </li>
  );
}

const BUILDER = "Rate-limit uploads";

const REVIEWER = "Review: Rate-limit uploads";

const PROMPT = "Rate-limit uploads, then start a Codex review";

const FOLLOW_UP = "Ask for a follow-up";

export function AgentSplit() {
  const { cycle, leaving } = useCycle(11500, 500);

  return (
    <div
      className="cmp-desktop"
      role="img"
      aria-label="The Omnyo desktop app: you ask Claude Code for a change, it starts a Codex reviewer nested under its thread, you open the reviewer in a split, Codex finishes its review and Claude Code fixes the findings"
    >
      <div className="cmp-desktop-bar">
        <span className="cmp-desktop-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div
        className={leaving ? "cmp-desktop-body leaving" : "cmp-desktop-body"}
        key={cycle}
      >
        <NavRail running={{ from: 2.3, until: 7 }} needs={1} />
        <aside className="cmp-side">
          <NewThreadButton />
          <span className="cmp-side-label">Threads</span>
          <ul className="cmp-rows">
            <SidebarRow
              parent
              selected
              provider={ClaudeIcon}
              title={BUILDER}
              age="now"
              working={{ from: 2.3, until: 7 }}
              glyph={
                <Phases
                  steps={[
                    { at: 0, node: null },
                    { at: 2.3, node: <WorkingGlyph /> },
                    { at: 3.4, node: <WorkingGlyph count={1} /> },
                    { at: 6, node: <WorkingGlyph /> },
                    { at: 7, node: <ReadyGlyph /> },
                  ]}
                />
              }
              subtitle={
                <Phases
                  steps={[
                    { at: 0, node: null },
                    {
                      at: 7,
                      node: "Per-user upload limits built and reviewed",
                    },
                  ]}
                />
              }
            />
            <SidebarRow
              kid
              className="cmp-anim-in"
              style={{ animationDelay: "3.4s" }}
              provider={OpenAiIcon}
              title={REVIEWER}
              age="now"
              working={{ from: 3.4, until: 6 }}
              glyph={
                <Phases
                  steps={[
                    { at: 0, node: <WorkingGlyph /> },
                    { at: 6, node: <ReadyGlyph /> },
                  ]}
                />
              }
              subtitle={
                <Phases
                  steps={[
                    { at: 0, node: null },
                    { at: 6, node: "One serious and two minor findings" },
                  ]}
                />
              }
            />
            <SidebarRow
              bold
              provider={OpenAiIcon}
              title="Issue triage"
              glyph={<ReadyGlyph />}
              age="1h ago"
            />
            <SidebarRow
              provider={ClaudeIcon}
              title="Add a dark mode toggle"
              glyph={<NeedsYouGlyph />}
              age="2h ago"
              subtitle="Needs you: header or Settings?"
            />
            <SidebarRow
              provider={ClaudeIcon}
              title="Fix emoji filenames"
              glyph={<ReadyGlyph />}
              age="3h ago"
            />
            <SidebarRow
              provider={ClaudeIcon}
              title="Fix flaky checkout test"
              glyph={<ReadyGlyph />}
              age="5h ago"
            />
          </ul>
        </aside>
        <div className="cmp-split">
          <section className="cmp-pane cmp-pane-focused">
            <PaneHead title={BUILDER} focused />
            <ol className="cmp-feed">
              <li className="cmp-user" style={{ animationDelay: "2.3s" }}>
                {PROMPT}
              </li>
              <li className="cmp-agent" style={{ animationDelay: "2.9s" }}>
                Added a per-user limiter in <code>rate-limit.ts</code>. Starting
                a Codex review.
              </li>
              <FinishedRow thread={REVIEWER} delay={6}>
                Serious: the limiter keys on the socket IP, so everyone behind
                the proxy shares one limit. Minor: buckets are never evicted,
                and 429s have no Retry-After.
              </FinishedRow>
              <li className="cmp-agent" style={{ animationDelay: "6.7s" }}>
                Keyed the limit on the user ID. <code>pnpm test</code>{" "}
                <span className="cmp-ok">passes</span>.
              </li>
            </ol>
            <div className="cmp-compose-stack">
              <div className="cmp-composer cmp-compose-prompt">
                <span className="cmp-composer-input cmp-input-stack">
                  <span className="cmp-type">{PROMPT}</span>
                  <span className="cmp-composer-placeholder cmp-input-after-send">
                    {FOLLOW_UP}
                  </span>
                </span>
                <ComposerRow
                  provider={ClaudeIcon}
                  model="Opus 5.5"
                  effort="Medium"
                  pulse
                />
              </div>
              <div className="cmp-composer cmp-compose-handoff">
                <span className="cmp-composer-head">
                  <HugeiconsIcon
                    icon={BubbleChatAddIcon}
                    className="cmp-composer-ic"
                  />
                  Handoff to new thread
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    className="cmp-composer-x"
                  />
                </span>
                <span className="cmp-composer-input">
                  Write release notes for <ThreadPill title={BUILDER} />
                </span>
                <ComposerRow
                  provider={OpenAiIcon}
                  model="GPT-5.5"
                  effort="Medium"
                />
              </div>
            </div>
          </section>
          <section className="cmp-pane cmp-pane-child">
            <div className="cmp-pane-inner">
              <PaneHead title={REVIEWER} closable />
              <ol className="cmp-feed">
                <li className="cmp-user" style={{ animationDelay: "4s" }}>
                  Review <code>git diff main..HEAD</code> read-only. Report
                  anything serious.
                </li>
                <li className="cmp-agent" style={{ animationDelay: "4.6s" }}>
                  Reading <code>rate-limit.ts</code> and <code>upload.ts</code>.
                </li>
                <li className="cmp-agent" style={{ animationDelay: "5.4s" }}>
                  One serious issue: the limiter keys on the socket IP. Two
                  minor: buckets are never evicted, and the 429 has no
                  Retry-After header.
                </li>
              </ol>
              <div className="cmp-composer">
                <span className="cmp-composer-head">
                  <HugeiconsIcon icon={UserIcon} className="cmp-composer-ic" />
                  Parent
                  <span className="cmp-composer-link">{BUILDER}</span>
                </span>
                <span className="cmp-composer-input cmp-composer-placeholder">
                  {FOLLOW_UP}
                </span>
                <ComposerRow
                  provider={OpenAiIcon}
                  model="GPT-5.5"
                  effort="Medium"
                />
              </div>
            </div>
          </section>
        </div>
      </div>
      <AppFooter />
    </div>
  );
}

export function SpawnTimeline() {
  const { cycle, leaving } = useCycle(9800, 500);

  return (
    <div
      className="cmp-crew"
      role="img"
      aria-label="Claude Code starts two Codex threads for a release, nested under its own thread. One asks a question and Claude Code answers it. Each posts a finished row back to Claude Code's thread, and the release is ready."
    >
      <div
        className={leaving ? "cmp-crew-body leaving" : "cmp-crew-body"}
        key={cycle}
      >
        <div className="cmp-crew-side">
          <NewThreadButton />
          <span className="cmp-side-label">Threads</span>
          <ul className="cmp-rows">
            <SidebarRow
              parent
              selected
              provider={ClaudeIcon}
              title="Ship the release"
              age="now"
              working={{ from: 0.4, until: 6.6 }}
              glyph={
                <Phases
                  steps={[
                    { at: 0, node: null },
                    { at: 0.4, node: <WorkingGlyph /> },
                    { at: 1.3, node: <WorkingGlyph count={2} /> },
                    { at: 4.3, node: <WorkingGlyph count={1} /> },
                    { at: 5.2, node: <WorkingGlyph /> },
                    { at: 6.6, node: <ReadyGlyph /> },
                  ]}
                />
              }
              subtitle={
                <Phases
                  steps={[
                    { at: 0, node: null },
                    { at: 6.6, node: "The release is ready to ship" },
                  ]}
                />
              }
            />
            <SidebarRow
              kid
              className="cmp-anim-in"
              style={{ animationDelay: "1.3s" }}
              provider={OpenAiIcon}
              title="Port module to TS"
              age="now"
              working={{ from: 1.3, until: 4.3 }}
              glyph={
                <Phases
                  steps={[
                    { at: 0, node: <WorkingGlyph /> },
                    { at: 4.3, node: <ReadyGlyph /> },
                  ]}
                />
              }
            />
            <SidebarRow
              kid
              className="cmp-anim-in"
              style={{ animationDelay: "1.3s" }}
              provider={OpenAiIcon}
              title="Refactor the auth flow"
              age="now"
              working={{ from: 1.3, until: 5.2 }}
              glyph={
                <Phases
                  steps={[
                    { at: 0, node: <WorkingGlyph /> },
                    { at: 5.2, node: <ReadyGlyph /> },
                  ]}
                />
              }
            />
            <SidebarRow
              bold
              provider={OpenAiIcon}
              title="Issue triage"
              glyph={<ReadyGlyph />}
              age="1h ago"
            />
          </ul>
        </div>
        <section className="cmp-pane cmp-crew-thread">
          <PaneHead title="Ship the release" focused />
          <ol className="cmp-feed">
            <li className="cmp-user" style={{ animationDelay: "0.4s" }}>
              Ship the release. Split up the work.
            </li>
            <li style={{ animationDelay: "1.1s" }}>
              Started two Codex threads, one task each.
            </li>
            <TimelineMessage
              label="Message from"
              thread="Port module to TS"
              delay={2.6}
            >
              Ported. One export changed shape. Should I update its callers?
            </TimelineMessage>
            <TimelineMessage
              label="Sent to"
              thread="Port module to TS"
              delay={3.5}
            >
              Yes, update them.
            </TimelineMessage>
            <FinishedRow thread="Port module to TS" delay={4.3}>
              Callers updated. The type check passes.
            </FinishedRow>
            <FinishedRow thread="Refactor the auth flow" delay={5.2}>
              Done. The auth tests pass.
            </FinishedRow>
            <li style={{ animationDelay: "6.6s" }}>
              Both are done. The release is ready.
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}
