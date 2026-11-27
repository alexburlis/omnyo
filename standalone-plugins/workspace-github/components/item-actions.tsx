import { useCallback, useEffect, useState } from "react";
import { useRpc, type PluginRpcResult } from "@omnyo/plugin-sdk/app";
import type { githubRpcContract } from "../server.js";
import { toast } from "sonner";
import { Button } from "./ui/button.js";
import { Icon } from "./ui/icon.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";

type Actions = PluginRpcResult<(typeof githubRpcContract)["itemActions"]>;

type MergeMethod = Actions["mergeMethods"][number];

const methodNames: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

export function ItemActions({
  kind,
  repo,
  number,
  state,
  onChanged,
  summary = [],
}: {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  state: string;
  onChanged: () => void;
  summary?: string[];
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [actions, setActions] = useState<Actions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [mergeError, setMergeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await rpc.call("itemActions", { kind, repo, number });
    setActions(result);
    setMethod(result.mergeMethods[0] ?? "squash");

    return result;
  }, [rpc, kind, repo, number]);

  useEffect(() => {
    let current = true;
    setActions(null);
    setError(null);
    setConfirming(false);
    rpc.call("itemActions", { kind, repo, number }).then(
      (result) => {
        if (!current) return;
        setActions(result);
        setMethod(result.mergeMethods[0] ?? "squash");
      },
      (failure) => {
        if (current)
          setError(
            failure instanceof Error ? failure.message : "Could not check GitHub permissions.",
          );
      },
    );

    return () => {
      current = false;
    };
  }, [rpc, kind, repo, number, state]);

  const merge = async () => {
    if (busy || actions === null) return;
    setBusy(true);
    setMergeError(null);

    try {
      if (actions.headOid === null) throw new Error("Reload the pull request before merging.");
      await rpc.call("mergePull", { repo, number, method, headOid: actions.headOid });
    } catch (failure) {
      setMergeError(
        failure instanceof Error ? failure.message : "GitHub could not complete this action.",
      );
      await load().catch(() => {});
      setBusy(false);

      return;
    }

    toast.success(`#${number} merged`);
    setConfirming(false);
    setBusy(false);
    onChanged();
    void load().catch(() => {});
  };

  const openMerge = () => {
    if (busy) return;
    setBusy(true);
    setMergeError(null);
    load().then(
      (result) => {
        setBusy(false);

        if (result.canMerge) setConfirming(true);
      },
      (failure) => {
        setBusy(false);
        setError(
          failure instanceof Error ? failure.message : "Could not check GitHub permissions.",
        );
      },
    );
  };

  const canChangeState = state === "CLOSED" ? actions?.canReopen : actions?.canClose;
  const stateLabel = state === "CLOSED" ? "Reopen" : "Close";
  const noun = kind === "pr" ? "pull request" : "issue";

  const mergeable = kind === "pr" && state !== "CLOSED" && state !== "MERGED";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {state !== "MERGED" ? (
        <div className="flex flex-wrap gap-2">
          {mergeable ? (
            <Button
              size="sm"
              variant="outline"
              className={
                actions?.canMerge === true
                  ? "h-8 gap-1.5 border-success/45 text-success-foreground dark:text-success hover:bg-success/10"
                  : "h-8 gap-1.5"
              }
              aria-label="Merge pull request"
              disabled={busy || !actions?.canMerge}
              onClick={openMerge}
            >
              <Icon name="GitMerge" aria-hidden="true" className="size-3.5" />
              Merge
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            aria-label={`${stateLabel} ${noun}`}
            disabled={busy || !canChangeState}
            onClick={() => setChangingState(true)}
          >
            {`${stateLabel}…`}
          </Button>
        </div>
      ) : null}
      {actions === null && error === null ? (
        <p className="text-xs text-subtle-foreground">Checking GitHub permissions…</p>
      ) : null}
      {actions !== null && state !== "MERGED" && !canChangeState ? (
        <p className="text-xs text-subtle-foreground">
          Your GitHub account cannot {stateLabel.toLowerCase()} this {noun}.
        </p>
      ) : null}
      {mergeable && actions?.mergeBlockReason ? (
        <p className="flex items-start gap-1.5 text-xs text-subtle-foreground">
          <Icon name="Lock" aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {actions.mergeBlockReason}
        </p>
      ) : null}
      <Dialog
        open={confirming && actions !== null}
        onOpenChange={(next) => {
          if (busy) return;
          setConfirming(next);

          if (!next) setMergeError(null);
        }}
      >
        <DialogContent hideCloseButton className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Merge pull request #{number}?</DialogTitle>
            <DialogDescription>{repo}</DialogDescription>
          </DialogHeader>
          {summary.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <p className="font-mono text-xs text-muted-foreground">
            Commit {actions?.headOid?.slice(0, 7)}
          </p>
          <Select
            value={method}
            onValueChange={(value) => {
              const allowed = actions?.mergeMethods.find((entry) => entry === value);

              if (allowed) setMethod(allowed);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="Merge method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(actions?.mergeMethods ?? []).map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {methodNames[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mergeError !== null ? (
            <p role="alert" className="text-sm text-destructive-text">
              {mergeError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setMergeError(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void merge()}>
              {busy ? "Merging…" : "Confirm merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
      <StateChangeDialog
        kind={kind}
        repo={repo}
        number={number}
        state={state}
        open={changingState}
        onOpenChange={setChangingState}
        onChanged={() => {
          onChanged();
          void load().catch(() => {});
        }}
      />
    </div>
  );
}

export function StateChangeDialog({
  kind,
  repo,
  number,
  state,
  open,
  onOpenChange,
  onChanged,
}: {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  state: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reopen = state === "CLOSED";
  const verb = reopen ? "Reopen" : "Close";
  const noun = kind === "pr" ? "pull request" : "issue";

  useEffect(() => {
    if (!open) return;

    let current = true;
    setAllowed(null);
    setError(null);
    rpc.call("itemActions", { kind, repo, number }).then(
      (result) => {
        if (current) setAllowed(reopen ? result.canReopen : result.canClose);
      },
      (failure) => {
        if (current)
          setError(
            failure instanceof Error ? failure.message : "Could not check GitHub permissions.",
          );
      },
    );

    return () => {
      current = false;
    };
  }, [rpc, open, kind, repo, number, reopen]);

  const confirm = async () => {
    if (busy || allowed !== true) return;
    setBusy(true);
    setError(null);

    try {
      await rpc.call(kind === "pr" ? "setPullState" : "setIssueState", {
        repo,
        number,
        state: reopen ? "open" : "closed",
      });
      toast.success(reopen ? `#${number} reopened` : `#${number} closed`);
      onOpenChange(false);
      onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "GitHub could not complete this action.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent hideCloseButton className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {verb} {noun} #{number}?
          </DialogTitle>
          <DialogDescription>{repo}</DialogDescription>
        </DialogHeader>
        {allowed === null && error === null ? (
          <p className="text-xs text-muted-foreground">Checking GitHub permissions…</p>
        ) : null}
        {allowed === false ? (
          <p className="text-xs text-muted-foreground">
            Your GitHub account cannot {verb.toLowerCase()} this {noun}.
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || allowed !== true} onClick={() => void confirm()}>
            {busy ? "Working…" : `${verb} ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
