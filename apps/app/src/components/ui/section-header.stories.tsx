import { useState } from "react";
import {
  getStaggerItemProps,
  useChangedSinceMount,
} from "@omnyo/shared-ui/motion";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CollapsibleSection,
  SectionHeader,
} from "@omnyo/shared-ui/section-header";

export default {
  title: "ui/Collapsible Section",
};

const SECTIONS = [
  {
    id: "running",
    title: "Running",
    description: undefined,
    rows: ["Polish the app", "Fix the relay reconnect", "Ship web update"],
  },
  {
    id: "waiting",
    title: "Waiting",
    description: "Comes back by itself",
    rows: ["Chief release version", "Distill new rules"],
  },
  {
    id: "ready",
    title: "Ready to archive",
    description: undefined,
    rows: [
      "Rename the onboarding step",
      "Update the docs",
      "Answer Ben",
      "Tidy branches",
    ],
  },
] as const;

function SectionRows({
  rows,
  open,
}: {
  rows: readonly string[];
  open: boolean;
}) {
  const reveal = useChangedSinceMount(open) && open;

  return (
    <ul className="flex flex-col gap-px py-1">
      {rows.map((row, index) => {
        const stagger = getStaggerItemProps(index, rows.length, reveal);

        return (
          <li
            key={row}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-foreground hover:bg-state-hover",
              stagger.className,
            )}
            style={stagger.style}
          >
            <Icon
              name="MessageSquare"
              aria-hidden="true"
              className="size-3.5 text-subtle-foreground"
            />
            {row}
          </li>
        );
      })}
    </ul>
  );
}

export function Overview() {
  const [open, setOpen] = useState<Record<string, boolean>>({
    running: true,
    waiting: true,
    ready: false,
  });

  return (
    <div className="m-6 flex w-80 flex-col gap-1 rounded-xl border border-border bg-sidebar p-2">
      {SECTIONS.map((section) => (
        <CollapsibleSection
          key={section.id}
          title={section.title}
          count={section.rows.length}
          countLabel={`${section.rows.length} chats`}
          description={section.description}
          open={open[section.id] ?? true}
          onOpenChange={(next) =>
            setOpen((current) => ({ ...current, [section.id]: next }))
          }
        >
          <SectionRows rows={section.rows} open={open[section.id] ?? true} />
        </CollapsibleSection>
      ))}
    </div>
  );
}

export function StaticHeader() {
  return (
    <div className="m-6 flex w-96 flex-col gap-2">
      <SectionHeader
        title="Dev servers"
        count={2}
        countLabel="2 servers"
        actions={
          <Button size="xs" variant="ghost">
            Stop all
          </Button>
        }
      />
      <SectionHeader title="Phases" description="3 of 5 complete" />
    </div>
  );
}
