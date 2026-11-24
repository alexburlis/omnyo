import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { HomeStatusPanel } from "./HomeOrientation";
import type { HomeNeedsRow } from "./home-orientation";

export default {
  title: "views/Home status panel",
};

const NOW = new Date(2026, 10, 21, 10, 0).getTime();

const MINUTE = 60_000;

const PROJECT_NAMES: ReadonlyMap<string, string> = new Map([
  ["omnyo", "omnyo"],
  ["site", "omnyohq.com"],
]);

function row(
  threadId: string,
  title: string,
  kind: HomeNeedsRow["kind"],
  minutesAgo: number,
  projectId = "omnyo",
): HomeNeedsRow {
  return {
    threadId,
    projectId,
    title,
    kind,
    at: NOW - minutesAgo * MINUTE,
  };
}

const NEEDS_ROWS: readonly HomeNeedsRow[] = [
  row("q", "Pick a name for the relay staging host", "question", 4),
  row("r", "Polish the Tools view", "result", 18, "site"),
  row("b", "Check the release offer after the reset", "returned", 52),
];

const MIXED_KIND_ROWS: readonly HomeNeedsRow[] = [
  row("p", "Usage window ran out during the import", "problem", 7),
  row("n", "Nightly digest", "runs", 35),
  row("c", "Summarise the design review", "chain", 90, "site"),
];

const FAILED_ROWS: readonly HomeNeedsRow[] = [
  row("f1", "Rebuild the plugin catalog index", "problem", 3),
  row("f2", "Migrate thread storage", "result", 41, "site"),
];

const noop = () => {};

function HomeColumn({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-[640px]">{children}</div>;
}

export function Overview() {
  return (
    <StoryCard labelWidth="190px">
      <StoryRow
        label="chats need you"
        hint="Each row says what kind of attention it needs. Hover a chip for a plain-language explanation. Open Inbox is a real button; the running and ready counts sit beside it as context."
      >
        <HomeColumn>
          <HomeStatusPanel
            needs={5}
            needsRows={NEEDS_ROWS}
            failed={0}
            failedRows={[]}
            running={2}
            ready={3}
            projectNames={PROJECT_NAMES}
            now={NOW}
            onOpenRow={noop}
            onOpenInbox={noop}
          />
        </HomeColumn>
      </StoryRow>
      <StoryRow
        label="other kinds"
        hint="Problem, several automation runs, and a wait that closed because the chat it waited for was archived."
      >
        <HomeColumn>
          <HomeStatusPanel
            needs={3}
            needsRows={MIXED_KIND_ROWS}
            failed={0}
            failedRows={[]}
            running={0}
            ready={0}
            projectNames={PROJECT_NAMES}
            now={NOW}
            onOpenRow={noop}
            onOpenInbox={noop}
          />
        </HomeColumn>
      </StoryRow>
      <StoryRow
        label="needs you and failed"
        hint="Failed chats get their own red group with a count and a short reason line."
      >
        <HomeColumn>
          <HomeStatusPanel
            needs={1}
            needsRows={NEEDS_ROWS.slice(0, 1)}
            failed={4}
            failedRows={FAILED_ROWS}
            running={1}
            ready={0}
            projectNames={PROJECT_NAMES}
            now={NOW}
            onOpenRow={noop}
            onOpenInbox={noop}
          />
        </HomeColumn>
      </StoryRow>
      <StoryRow
        label="nothing needs you"
        hint="Only running and ready-to-archive counts remain."
      >
        <HomeColumn>
          <HomeStatusPanel
            needs={0}
            needsRows={[]}
            failed={0}
            failedRows={[]}
            running={3}
            ready={2}
            projectNames={PROJECT_NAMES}
            now={NOW}
            onOpenRow={noop}
            onOpenInbox={noop}
          />
        </HomeColumn>
      </StoryRow>
    </StoryCard>
  );
}
