import { useEffect, useRef, useState } from "react";
import { useRpc, type PluginRpcResult } from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { Item } from "../app-logic.js";
import { errorText } from "../data.js";
import { itemKey, repoName } from "../launchpad.js";
import type { githubRpcContract } from "../server.js";
import { cn } from "../lib/utils.js";
import { StateGlyph } from "./glyphs.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Icon } from "./ui/icon.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";

type MergeMethod = PluginRpcResult<
  (typeof githubRpcContract)["itemActions"]
>["mergeMethods"][number];

type RowState =
  | { phase: "checking" }
  | { phase: "ready"; methods: MergeMethod[]; headOid: string }
  | { phase: "blocked"; reason: string }
  | { phase: "merging"; method: MergeMethod }
  | { phase: "merged"; method: MergeMethod }
  | { phase: "failed"; reason: string };

const methodNames: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

const methodSchemaValues: MergeMethod[] = ["squash", "merge", "rebase"];

function chosenMethod(preferred: MergeMethod, methods: MergeMethod[]): MergeMethod | null {
  return methods.includes(preferred) ? preferred : (methods[0] ?? null);
}

export function BulkMergeDialog({
  pulls,
  open,
  onOpenChange,
}: {
  pulls: Item[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [rows, setRows] = useState<Map<string, RowState>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [preferred, setPreferred] = useState<MergeMethod>("squash");
  const [running, setRunning] = useState(false);
  const stopRequested = useRef(false);

  useEffect(
    () => () => {
      stopRequested.current = true;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    let current = true;
    setRows(new Map(pulls.map((pull) => [itemKey(pull), { phase: "checking" }])));
    setSelected([]);
    stopRequested.current = false;

    const queue = [...pulls];

    const worker = async () => {
      for (let pull = queue.shift(); pull !== undefined; pull = queue.shift()) {
        const key = itemKey(pull);
        let state: RowState;

        try {
          const actions = await rpc.call("itemActions", {
            kind: "pr",
            repo: pull.repo,
            number: pull.number,
          });

          state =
            actions.canMerge && actions.headOid !== null && actions.mergeMethods.length > 0
              ? { phase: "ready", methods: actions.mergeMethods, headOid: actions.headOid }
              : {
                  phase: "blocked",
                  reason: actions.mergeBlockReason ?? "GitHub does not allow merging this one.",
                };
        } catch (error) {
          state = { phase: "blocked", reason: errorText(error) };
        }

        if (!current) return;
        setRows((previous) => new Map(previous).set(key, state));

        if (state.phase === "ready") setSelected((previous) => [...previous, key]);
      }
    };

    void Promise.all([worker(), worker(), worker(), worker()]);

    return () => {
      current = false;
    };
  }, [open, pulls, rpc]);

  const checking = [...rows.values()].some((row) => row.phase === "checking");
  const finished = [...rows.values()].filter((row) => row.phase === "merged").length;

  const run = async () => {
    setRunning(true);
    stopRequested.current = false;
    let merged = 0;
    let failed = 0;

    for (const pull of pulls) {
      const key = itemKey(pull);
      const row = rows.get(key);

      if (stopRequested.current) break;

      if (!selected.includes(key) || row?.phase !== "ready") continue;
      const method = chosenMethod(preferred, row.methods);

      if (method === null) continue;
      setRows((previous) => new Map(previous).set(key, { phase: "merging", method }));

      try {
        await rpc.call("mergePull", {
          repo: pull.repo,
          number: pull.number,
          method,
          headOid: row.headOid,
        });
        merged += 1;
        setRows((previous) => new Map(previous).set(key, { phase: "merged", method }));
      } catch (error) {
        failed += 1;
        setRows((previous) =>
          new Map(previous).set(key, { phase: "failed", reason: errorText(error) }),
        );
      }
    }

    setSelected([]);
    setRunning(false);

    if (failed > 0) toast.error(`${merged} merged, ${failed} failed`);
    else toast.success(`${merged} pull request${merged === 1 ? "" : "s"} merged`);
  };

  const toggle = (key: string) =>
    setSelected((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent hideCloseButton className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge ready pull requests</DialogTitle>
          <DialogDescription>
            Each pull request is checked again on GitHub and merged at the commit checked here.
            Untick any you want to keep open.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Preferred method</span>
          <Select
            value={preferred}
            disabled={running}
            onValueChange={(value) => {
              const method = methodSchemaValues.find((entry) => entry === value);

              if (method !== undefined) setPreferred(method);
            }}
          >
            <SelectTrigger aria-label="Preferred merge method" className="h-7 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {methodSchemaValues.map((method) => (
                <SelectItem key={method} value={method}>
                  {methodNames[method]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto tabular-nums">
            {selected.length} selected{finished > 0 ? ` · ${finished} merged` : ""}
          </span>
        </div>
        <ul
          aria-label="Pull requests to merge"
          className="max-h-80 overflow-y-auto rounded-md border border-border"
        >
          {pulls.map((pull) => {
            const key = itemKey(pull);
            const row = rows.get(key) ?? { phase: "checking" };

            const method =
              row.phase === "ready"
                ? chosenMethod(preferred, row.methods)
                : row.phase === "merging" || row.phase === "merged"
                  ? row.method
                  : null;

            return (
              <li
                key={key}
                className="grid min-h-9 grid-cols-[1rem_1rem_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border-seam px-2.5 py-1 last:border-b-0"
              >
                <input
                  type="checkbox"
                  aria-label={`Merge ${pull.repo}#${pull.number}`}
                  checked={selected.includes(key)}
                  disabled={running || row.phase !== "ready"}
                  onChange={() => toggle(key)}
                  className="size-3.5 accent-current"
                />
                <StateGlyph kind="pr" state={row.phase === "merged" ? "MERGED" : pull.state} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{pull.title}</span>
                  <span className="block truncate text-xs text-subtle-foreground">
                    {repoName(pull.repo)} #{pull.number}
                    {method === null ? "" : ` · ${methodNames[method]}`}
                  </span>
                </span>
                <span
                  className={cn(
                    "max-w-48 truncate text-right text-xs",
                    row.phase === "merged" && "text-success-foreground dark:text-success",
                    (row.phase === "failed" || row.phase === "blocked") && "text-destructive-text",
                    (row.phase === "checking" || row.phase === "merging") &&
                      "text-subtle-foreground",
                    row.phase === "ready" && "text-muted-foreground",
                  )}
                  title={row.phase === "failed" || row.phase === "blocked" ? row.reason : undefined}
                >
                  {row.phase === "checking"
                    ? "Checking…"
                    : row.phase === "ready"
                      ? "Ready"
                      : row.phase === "merging"
                        ? "Merging…"
                        : row.phase === "merged"
                          ? "Merged"
                          : row.reason}
                </span>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          {running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                stopRequested.current = true;
              }}
            >
              Stop after this one
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              {finished > 0 ? "Close" : "Cancel"}
            </Button>
          )}
          <Button
            size="sm"
            disabled={running || checking || selected.length === 0}
            onClick={() => void run()}
          >
            <Icon name="GitMerge" aria-hidden="true" className="size-3.5" />
            {running
              ? "Merging…"
              : `Merge ${selected.length} pull request${selected.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
