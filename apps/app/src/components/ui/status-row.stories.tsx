import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { MetaChip } from "@omnyo/shared-ui/meta-chip";
import {
  StatusBadge,
  StatusDot,
  StatusList,
  StatusRow,
  type StatusTone,
} from "@omnyo/shared-ui/status-row";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Status Row",
};

const TONES: readonly { tone: StatusTone; label: string }[] = [
  { tone: "active", label: "Running" },
  { tone: "success", label: "Done" },
  { tone: "pending", label: "Starting" },
  { tone: "warning", label: "Port in use" },
  { tone: "error", label: "Didn’t start" },
  { tone: "neutral", label: "Stopped" },
];

export function Overview() {
  return (
    <div className="m-6 flex max-w-2xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-xs font-semibold text-muted-foreground">
          Dev servers
        </h3>
        <StatusList label="Dev servers">
          <StatusRow
            tone="active"
            title="localhost:61424"
            status="Running"
            meta={["Mac Pro", "started 4 min ago"]}
            actions={
              <Button size="xs" variant="soft">
                <Icon name="ExternalLink" />
                Open
              </Button>
            }
          />
          <StatusRow
            tone="error"
            title="localhost:61423"
            status="Didn’t start"
            meta={["Mac Pro", "last run"]}
            error="The preview command exited with code 1."
            actions={
              <Button size="xs" variant="soft">
                <Icon name="RotateCcw" />
                Restart
              </Button>
            }
          />
          <StatusRow
            tone="pending"
            title="localhost:5173"
            status="Starting"
            meta={["3090"]}
            detail="Waiting for the server to answer on this port."
          />
        </StatusList>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-xs font-semibold text-muted-foreground">
          Waits
        </h3>
        <StatusList label="Waits">
          <StatusRow
            tone="pending"
            title="Chief release version and updater offer"
            status="Waiting for a chat"
            detail="Comes back here when that chat reports a result."
            actions={
              <Button size="xs" variant="soft">
                Cancel wait
              </Button>
            }
          />
          <StatusRow
            tone="neutral"
            title="Run omnyo chief distill, then summarize any new rule"
            status="Repeats"
            meta={["every 30 min", "next at 14:30"]}
            actions={
              <Button size="xs" variant="soft">
                Cancel wait
              </Button>
            }
          />
        </StatusList>
      </section>
    </div>
  );
}

export function Tones() {
  return (
    <StoryCard>
      {TONES.map(({ tone, label }) => (
        <StoryRow key={tone} label={tone}>
          <StatusDot tone={tone} />
          <StatusBadge tone={tone}>{label}</StatusBadge>
        </StoryRow>
      ))}
      <StoryRow label="explained chips" hint="hover or focus for the meaning">
        <MetaChip
          icon="CornerDownLeft"
          label="1"
          description="1 reply is waiting for you"
        />
        <MetaChip
          icon="Clock"
          label="2"
          description="2 waits will bring this chat back"
          tone="attention"
        />
        <MetaChip icon="Check" description="Ready to archive" tone="success" />
      </StoryRow>
    </StoryCard>
  );
}
