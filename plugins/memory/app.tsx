import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginRpcResult,
} from "@omnyo/plugin-sdk/app";
import type { memoryRpcContract } from "./server.js";
import { isMemoryKind, MEMORY_KINDS } from "./memory-kinds.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyStateBlock } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type MemoryRecord = PluginRpcResult<
  (typeof memoryRpcContract)["listMemories"]
>["memories"][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MEMORY_KIND_LABELS: Record<MemoryRecord["kind"], string> = {
  decision: "Decision",
  episode: "Episode",
  fact: "Fact",
  preference: "Preference",
  procedure: "Procedure",
  reference: "Reference",
};

const MEMORY_SCOPE_LABELS: Record<MemoryRecord["scope"], string> = {
  global: "Global",
  project: "Project",
};

function MemoryChip({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex h-5 max-w-48 shrink-0 items-center gap-1 truncate rounded-full bg-state-hover px-2 text-xs text-muted-foreground"
    >
      {children}
    </span>
  );
}

function MemoryEditor({
  memory,
  onCancel,
  onSaved,
}: {
  memory: MemoryRecord;
  onCancel: () => void;
  onSaved: (memory: MemoryRecord) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [draft, setDraft] = useState(memory);
  const [tags, setTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="@container/memory-editor space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 @min-[36rem]/memory-editor:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Summary
          <Input
            aria-label="Memory summary"
            value={draft.summary}
            maxLength={400}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Tags
          <Input
            aria-label="Memory tags"
            value={tags}
            placeholder="comma, separated"
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Details
        <Textarea
          aria-label="Memory details"
          value={draft.details}
          maxLength={16_000}
          className="min-h-28 resize-y text-sm"
          onChange={(event) =>
            setDraft({ ...draft, details: event.target.value })
          }
        />
      </label>
      <div className="grid gap-3 @min-[32rem]/memory-editor:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Kind
          <Select
            value={draft.kind}
            onValueChange={(kind) => {
              if (isMemoryKind(kind)) {
                setDraft({ ...draft, kind });
              }
            }}
          >
            <SelectTrigger aria-label="Memory kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {MEMORY_KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Importance
          <Input
            aria-label="Memory importance"
            type="number"
            min={0}
            max={100}
            value={draft.importance}
            onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <Switch
            aria-label="Pinned memory"
            checked={draft.pinned}
            onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
          />
          Pinned
        </label>
      </div>
      {error ? (
        <p className="text-xs text-destructive-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void rpc
              .call("updateMemory", {
                id: draft.id,
                expectedVersion: draft.version,
                summary: draft.summary,
                details: draft.details,
                kind: draft.kind,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                importance: draft.importance,
                pinned: draft.pinned,
              })
              .then((result) => result.memory)
              .then(onSaved)
              .catch((saveError: unknown) => setError(errorMessage(saveError)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function MemoryRow({
  memory,
  editing,
  deleting,
  onToggleEdit,
  onDelete,
  onSaved,
}: {
  memory: MemoryRecord;
  editing: boolean;
  deleting: boolean;
  onToggleEdit: () => void;
  onDelete: () => void;
  onSaved: (memory: MemoryRecord) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <li
      className={cn(
        "space-y-3 rounded-lg border bg-card px-3.5 py-3",
        editing ? "border-ring/50" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {memory.pinned ? (
              <Icon
                name="Pin"
                aria-label="Pinned"
                className="size-3.5 shrink-0 text-warning-text"
              />
            ) : null}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {memory.name}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-sm leading-snug text-muted-foreground">
            {memory.summary}
          </p>
        </div>
        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Delete?</span>
            <Button
              size="xs"
              variant="destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? "Deleting…" : "Delete memory"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="soft"
              aria-expanded={editing}
              onClick={onToggleEdit}
            >
              Edit
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete ${memory.name}`}
              className="text-muted-foreground hover:text-destructive-text"
              onClick={() => setConfirmingDelete(true)}
            >
              <Icon name="Trash2" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <MemoryChip>{MEMORY_KIND_LABELS[memory.kind]}</MemoryChip>
        <MemoryChip title={memory.projectId ?? undefined}>
          <Icon
            name={memory.scope === "global" ? "Globe" : "Folder"}
            aria-hidden
            className="size-3 shrink-0"
          />
          {MEMORY_SCOPE_LABELS[memory.scope]}
        </MemoryChip>
        <MemoryChip title="From 0 to 100. Agents see higher-importance memories first; pinned memories always come first.">
          Importance {memory.importance}
        </MemoryChip>
        {memory.tags.map((tag) => (
          <MemoryChip key={tag}>#{tag}</MemoryChip>
        ))}
        <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
          Updated {new Date(memory.updatedAt).toLocaleDateString()}
        </span>
      </div>
      {editing ? (
        <MemoryEditor
          memory={memory}
          onCancel={onToggleEdit}
          onSaved={onSaved}
        />
      ) : null}
    </li>
  );
}

function MemorySettings() {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setMemories((await rpc.call("listMemories")).memories);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteMemory = (memory: MemoryRecord) => {
    setDeletingId(memory.id);
    setError(null);
    void rpc
      .call("deleteMemory", {
        id: memory.id,
        expectedVersion: memory.version,
      })
      .then(() => {
        setMemories((current) =>
          current.filter((entry) => entry.id !== memory.id),
        );
        setEditingId((current) => (current === memory.id ? null : current));
      })
      .catch((deleteError: unknown) => setError(errorMessage(deleteError)))
      .finally(() => setDeletingId(null));
  };

  return (
    <MemorySettingsView
      memories={memories}
      loading={loading}
      error={error}
      editingId={editingId}
      deletingId={deletingId}
      onToggleEdit={(memory) =>
        setEditingId((current) => (current === memory.id ? null : memory.id))
      }
      onDelete={deleteMemory}
      onSaved={(updated) => {
        setMemories((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
        setEditingId(null);
      }}
    />
  );
}

export interface MemorySettingsViewProps {
  memories: readonly MemoryRecord[];
  loading: boolean;
  error: string | null;
  editingId: string | null;
  deletingId: string | null;
  onToggleEdit: (memory: MemoryRecord) => void;
  onDelete: (memory: MemoryRecord) => void;
  onSaved: (memory: MemoryRecord) => void;
}

export function MemorySettingsView({
  memories,
  loading,
  error,
  editingId,
  deletingId,
  onToggleEdit,
  onDelete,
  onSaved,
}: MemorySettingsViewProps) {
  if (loading) {
    return (
      <div role="status" aria-label="Loading memories" className="space-y-2">
        <Skeleton aria-hidden className="h-16 w-full rounded-lg" />
        <Skeleton aria-hidden className="h-16 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Icon name="Info" />
        <AlertDescription className="text-muted-foreground">
          Every provider reads and writes these memories. Turn off each
          provider’s own memory under Settings → Providers so the two stores
          don’t disagree.
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <Icon name="AlertCircle" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {memories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border">
          <EmptyStateBlock
            icon="Brain"
            title="No memories yet"
            description="When an agent learns a fact, preference or decision worth keeping, it saves it here so later chats can recall it."
          />
        </div>
      ) : (
        <ul aria-label="Memories" className="space-y-2">
          {memories.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              editing={editingId === memory.id}
              deleting={deletingId === memory.id}
              onToggleEdit={() => onToggleEdit(memory)}
              onDelete={() => onDelete(memory)}
              onSaved={onSaved}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "memory",
    title: "Memory",
    description:
      "Review and manage provider-independent global and project memories.",
    component: MemorySettings,
  });
});
