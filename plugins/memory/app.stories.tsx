import { useState, type ReactNode } from "react";
import { MemorySettingsView, type MemoryRecord } from "./app.js";

export default {
  title: "plugins/Memory",
};

const DAY = 86_400_000;

function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description === undefined ? null : (
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card px-4 py-3.5">
        {children}
      </div>
    </section>
  );
}

const memories: MemoryRecord[] = [
  {
    id: "mem_1",
    scope: "global",
    projectId: null,
    name: "Package manager",
    summary:
      "Use pnpm for every Node.js project unless the repository requires another package manager.",
    details: "",
    kind: "preference",
    tags: ["node", "tooling"],
    importance: 80,
    pinned: true,
    version: 3,
    updatedAt: Date.now() - 2 * DAY,
    createdAt: Date.now() - 60 * DAY,
    sourceThreadId: null,
    writeReason: "Stated by the owner in a chat.",
  },
  {
    id: "mem_2",
    scope: "project",
    projectId: "proj_omnyo",
    name: "Focused tests",
    summary:
      "Run pnpm test:dev with explicit files; full suites are only for release verification.",
    details: "",
    kind: "procedure",
    tags: ["testing"],
    importance: 60,
    pinned: false,
    version: 1,
    updatedAt: Date.now() - 9 * DAY,
    createdAt: Date.now() - 60 * DAY,
    sourceThreadId: null,
    writeReason: "Stated by the owner in a chat.",
  },
  {
    id: "mem_3",
    scope: "project",
    projectId: "proj_omnyo",
    name: "SQLite on the VPS",
    summary:
      "Prefer the smallest SQLite setup on the existing Coolify VPS for new app persistence.",
    details: "",
    kind: "decision",
    tags: [],
    importance: 45,
    pinned: false,
    version: 2,
    updatedAt: Date.now() - 31 * DAY,
    createdAt: Date.now() - 60 * DAY,
    sourceThreadId: null,
    writeReason: "Stated by the owner in a chat.",
  },
];

function MemoryStage({ initial }: { initial: MemoryRecord[] }) {
  const [list, setList] = useState(initial);

  return (
    <SettingsCard
      title="Memory"
      description="Review and manage provider-independent global and project memories."
    >
      <MemorySettingsView
        memories={list}
        loading={false}
        error={null}
        editingId={null}
        deletingId={null}
        onToggleEdit={() => {}}
        onDelete={(memory) =>
          setList((current) =>
            current.filter((entry) => entry.id !== memory.id),
          )
        }
        onSaved={() => {}}
      />
    </SettingsCard>
  );
}

export function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6">
      <MemoryStage initial={memories} />
      <MemoryStage initial={[]} />
    </div>
  );
}
