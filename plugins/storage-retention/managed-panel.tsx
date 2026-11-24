import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  MANAGED_HOLDING_MS,
  type ManagedAdminRequest,
  type ManagedAllocation,
  type ManagedPolicy,
  type ManagedPolicyDraft,
  type ManagedState,
  type managedRpc,
} from "./src/managed-contract.js";

type ExactItem = Extract<
  ManagedAdminRequest,
  { action: "purge-preview" }
>["items"][number];

type Confirmation =
  | {
      kind: "item";
      action: "review" | "restore" | "purge";
      item: ManagedAllocation;
      exact: ExactItem;
    }
  | {
      kind: "policy";
      policy: ManagedPolicyDraft;
      expectedRevision: number;
      previewDigest: string;
      preview: NonNullable<ManagedState["preview"]>;
    }
  | { kind: "batch"; items: ExactItem[]; previewDigest: string };

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);

  return `${Number((value / 1024 ** index).toFixed(1))} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}

function policyDraft(policy: ManagedPolicy): ManagedPolicyDraft {
  return {
    mode: policy.mode,
    automaticExpiry: policy.automaticExpiry,
    quarantineBudgetBytes: policy.quarantineBudgetBytes,
  };
}

function exactItem(item: ManagedAllocation): ExactItem | null {
  return item.snapshot === null
    ? null
    : {
        hostId: item.hostId,
        id: item.id,
        revision: item.revision,
        snapshotDigest: item.snapshot.digest,
      };
}

function canPurge(item: ManagedAllocation) {
  return (
    item.phase === "quarantined" &&
    item.quarantinedAt !== null &&
    item.quarantinedAt + MANAGED_HOLDING_MS <= Date.now() &&
    item.snapshot !== null &&
    item.grant !== null &&
    item.reviewedAt !== null &&
    item.hold === null
  );
}

function phaseLabel(item: ManagedAllocation) {
  switch (item.phase) {
    case "allocated":
      return "Awaiting owner";
    case "kept":
      return "Kept by owner";
    case "proposed":
      return item.grant === null ? "Awaiting owner release" : "Awaiting review";
    case "approved":
      return "Approved for quarantine";
    case "quarantine-intent":
      return "Quarantine needs reconciliation";
    case "quarantined":
      return "Quarantined";
    case "restore-intent":
      return "Restore needs reconciliation";
    case "purge-intent":
      return "Permanent removal needs reconciliation";
    case "removed":
      return "Permanently removed";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ManagedCleanupPanel({ hostId }: { hostId: string | null }) {
  const rpc = useRpc<typeof managedRpc>();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ManagedState | null>(null);
  const [draft, setDraft] = useState<ManagedPolicyDraft | null>(null);
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const epoch = useRef(0);
  const fetchSequence = useRef(0);
  const operationSequence = useRef(0);
  const busyRef = useRef(false);
  const editingPolicy = useRef(false);

  const invalidate = useCallback(() => {
    epoch.current++;
    operationSequence.current++;
  }, []);

  const acceptState = useCallback(
    (next: ManagedState, replaceDraft: boolean) => {
      const updateDraft = replaceDraft || !editingPolicy.current;

      if (replaceDraft) editingPolicy.current = false;
      setState(next);
      setDraft((current) =>
        updateDraft || current === null ? policyDraft(next.policy) : current,
      );
      setBudget((current) =>
        updateDraft || current === ""
          ? String(next.policy.quarantineBudgetBytes / 1024 ** 3)
          : current,
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!open || busyRef.current) return;
    const currentEpoch = epoch.current;
    const sequence = ++fetchSequence.current;
    setLoading(true);

    try {
      const next = await rpc.call("managedState", null);

      if (currentEpoch !== epoch.current || sequence !== fetchSequence.current)
        return;
      acceptState(next, false);
      setConfirmation(null);
      setSelected([]);
      setError(null);
    } catch (failure) {
      if (currentEpoch === epoch.current && sequence === fetchSequence.current)
        setError(errorMessage(failure));
    } finally {
      if (currentEpoch === epoch.current && sequence === fetchSequence.current)
        setLoading(false);
    }
  }, [acceptState, open, rpc]);

  useEffect(() => {
    invalidate();
    busyRef.current = false;
    editingPolicy.current = false;
    setBusy(false);
    setState(null);
    setDraft(null);
    setBudget("");
    setConfirmation(null);
    setSelected([]);
    setError(null);
    void refresh();

    return invalidate;
  }, [hostId, invalidate, refresh]);

  useRealtime("managed-changed", refresh);

  async function request(
    input: ManagedAdminRequest,
    onResult?: (next: ManagedState) => void,
  ) {
    const currentEpoch = ++epoch.current;
    const operation = ++operationSequence.current;
    busyRef.current = true;
    setBusy(true);
    setLoading(false);
    setError(null);

    try {
      const next = await rpc.call("managedRequest", input);

      if (currentEpoch !== epoch.current) return;
      epoch.current++;
      acceptState(next, input.action === "configure");
      setSelected([]);
      setConfirmation(null);
      onResult?.(next);
    } catch (failure) {
      if (currentEpoch === epoch.current) setError(errorMessage(failure));
    } finally {
      if (operation === operationSequence.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const items =
    state?.allocations.filter(
      (item) => hostId === null || item.hostId === hostId,
    ) ?? [];

  const failures =
    state?.failures.filter(
      (failure) => hostId === null || failure.hostId === hostId,
    ) ?? [];

  const quarantinedBytes = items
    .filter((item) => item.phase === "quarantined")
    .reduce((total, item) => total + (item.snapshot?.logicalBytes ?? 0), 0);

  const removedBytes = items.reduce(
    (total, item) => total + item.removedLogicalBytes,
    0,
  );

  const selectedItems = items
    .filter((item) => selected.includes(item.id) && canPurge(item))
    .flatMap((item) => {
      const exact = exactItem(item);

      return exact === null ? [] : [exact];
    });

  const budgetBytes = Number(budget) * 1024 ** 3;
  const validBudget = Number.isSafeInteger(budgetBytes) && budgetBytes > 0;

  const policyChanged =
    state !== null &&
    draft !== null &&
    (draft.mode !== state.policy.mode ||
      draft.automaticExpiry !== state.policy.automaticExpiry ||
      budgetBytes !== state.policy.quarantineBudgetBytes);

  async function previewPolicy() {
    if (state === null || draft === null || !validBudget) return;
    const policy = { ...draft, quarantineBudgetBytes: budgetBytes };
    const expectedRevision = state.policy.revision;
    await request({ action: "policy-preview", policy }, (next) => {
      if (next.preview === null) {
        setError("The policy preview was unavailable. Try again.");

        return;
      }

      setConfirmation({
        kind: "policy",
        policy,
        expectedRevision,
        previewDigest: next.preview.digest,
        preview: next.preview,
      });
    });
  }

  async function confirm() {
    if (confirmation === null) return;

    if (confirmation.kind === "policy") {
      await request({
        action: "configure",
        policy: confirmation.policy,
        expectedRevision: confirmation.expectedRevision,
        previewDigest: confirmation.previewDigest,
      });
    } else if (confirmation.kind === "batch") {
      await request({
        action: "purge-batch",
        items: confirmation.items,
        previewDigest: confirmation.previewDigest,
      });
    } else {
      await request({ action: confirmation.action, ...confirmation.exact });
    }
  }

  return (
    <section className="space-y-3" aria-label="Managed cleanup">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Managed cleanup</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            Review temporary files allocated by their owner chats.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close managed cleanup" : "Open managed cleanup"}
        </Button>
      </div>
      {open && (
        <div className="space-y-4">
          {error !== null && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              <p>{error}</p>
              {state === null && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  Try again
                </Button>
              )}
            </div>
          )}
          {loading && (
            <p role="status" className="text-xs text-muted-foreground">
              Loading managed cleanup…
            </p>
          )}
          {state !== null && draft !== null && (
            <>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                <div className="space-y-2 px-4 py-3">
                  <p className="text-sm font-medium">Quarantine approval</p>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Quarantine approval"
                  >
                    <Button
                      variant={
                        draft.mode === "review" ? "secondary" : "outline"
                      }
                      size="sm"
                      aria-pressed={draft.mode === "review"}
                      disabled={busy}
                      onClick={() => {
                        editingPolicy.current = true;
                        setDraft({ ...draft, mode: "review" });
                        setConfirmation(null);
                      }}
                    >
                      Review each release
                    </Button>
                    <Button
                      variant={
                        draft.mode === "owner-approved"
                          ? "secondary"
                          : "outline"
                      }
                      size="sm"
                      aria-pressed={draft.mode === "owner-approved"}
                      disabled={busy}
                      onClick={() => {
                        editingPolicy.current = true;
                        setDraft({ ...draft, mode: "owner-approved" });
                        setConfirmation(null);
                      }}
                    >
                      Use owner chat releases
                    </Button>
                  </div>
                  <p className="text-xs leading-snug text-muted-foreground">
                    Only the owner chat can release files. Every quarantine
                    requires safety checks.
                  </p>
                </div>
                <label className="flex items-center justify-between gap-4 px-4 py-3">
                  <span>
                    <span className="block text-sm font-medium">
                      Automatically remove quarantined files
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Off by default. Enabling starts a new seven-day minimum
                      for existing quarantined files.
                    </span>
                  </span>
                  <Switch
                    aria-label="Automatically remove quarantined files"
                    checked={draft.automaticExpiry}
                    disabled={busy}
                    onCheckedChange={(checked) => {
                      editingPolicy.current = true;
                      setDraft({ ...draft, automaticExpiry: checked });
                      setConfirmation(null);
                    }}
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <label
                    className="space-y-1"
                    htmlFor="managed-quarantine-budget"
                  >
                    <span className="block text-sm font-medium">
                      Quarantine budget (GiB)
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      A full quarantine holds new cleanup; it never evicts
                      files.
                    </span>
                  </label>
                  <input
                    id="managed-quarantine-budget"
                    type="number"
                    min="0.001"
                    step="any"
                    value={budget}
                    disabled={busy}
                    onChange={(event) => {
                      editingPolicy.current = true;
                      setBudget(event.target.value);
                      setConfirmation(null);
                    }}
                    className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm tabular-nums"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Managed policy is separate from automatic thread retention.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !validBudget || !policyChanged}
                    onClick={() => void previewPolicy()}
                  >
                    Preview policy change
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <p>
                  Quarantined:{" "}
                  <span className="tabular-nums text-foreground">
                    {bytes(quarantinedBytes)}
                  </span>{" "}
                  logical bytes; still on disk.
                </p>
                <p>
                  Permanently removed:{" "}
                  <span className="tabular-nums text-foreground">
                    {bytes(removedBytes)}
                  </span>{" "}
                  logical bytes.
                </p>
              </div>
              {failures.map((failure) => (
                <p
                  role="alert"
                  key={failure.hostId}
                  className="text-sm text-destructive"
                >
                  {failure.hostId}: {failure.message}
                </p>
              ))}
              {items.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {failures.length > 0
                    ? "Managed allocations could not be fully loaded."
                    : "No managed allocations reported."}
                </p>
              )}
              <div className="space-y-3">
                {items.map((item) => {
                  const exact = exactItem(item);
                  const purge = canPurge(item);

                  return (
                    <article
                      key={`${item.hostId}:${item.id}`}
                      aria-label={item.purpose}
                      className="space-y-3 rounded-lg border border-border bg-card px-4 py-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="break-words text-sm font-medium">
                            {item.purpose}
                          </h3>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {phaseLabel(item)} ·{" "}
                            {item.snapshot === null
                              ? "Size not measured"
                              : `${bytes(item.snapshot.logicalBytes)} logical`}
                          </p>
                        </div>
                        {purge && (
                          <Checkbox
                            aria-label={`Select ${item.purpose} for permanent removal`}
                            checked={selected.includes(item.id)}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              setSelected((current) =>
                                checked === true
                                  ? [...current, item.id]
                                  : current.filter((id) => id !== item.id),
                              )
                            }
                          />
                        )}
                      </div>
                      <dl className="space-y-1 text-xs text-muted-foreground">
                        <div>
                          <dt className="inline">Owner: </dt>
                          <dd className="inline break-all">
                            {item.ownerThreadId}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline">Machine: </dt>
                          <dd className="inline break-all">{item.hostId}</dd>
                        </div>
                        <div>
                          <dt className="inline">Path: </dt>
                          <dd className="inline break-all font-mono">
                            {item.path}
                          </dd>
                        </div>
                        {item.path !== item.originalPath && (
                          <div>
                            <dt className="inline">Restore path: </dt>
                            <dd className="inline break-all font-mono">
                              {item.originalPath}
                            </dd>
                          </div>
                        )}
                        {item.reason !== null && (
                          <div>
                            <dt className="inline">Owner reason: </dt>
                            <dd className="inline">{item.reason}</dd>
                          </div>
                        )}
                        <div>
                          <dt className="inline">Owner intent: </dt>
                          <dd className="inline">
                            {item.disposition === "keep-until-released"
                              ? "Keep until the owner releases it"
                              : "Disposable when the owner ends"}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline">Storage declaration: </dt>
                          <dd className="inline">
                            {item.storage === null
                              ? "Unknown legacy declaration; files remain protected"
                              : `${item.storage.role}, ${bytes(item.storage.budgetBytes)} logical budget, ${bytes(item.storage.minimumFreeBytes)} free-space reserve`}
                          </dd>
                        </div>
                        {item.storage !== null &&
                          item.storage.restoreInputs.length > 0 && (
                            <div>
                              <dt>Restore inputs</dt>
                              {item.storage.restoreInputs.map((input) => (
                                <dd
                                  key={`${input.reference}:${input.sha256}`}
                                  className="break-all font-mono"
                                >
                                  {input.reference} · {input.sha256}
                                </dd>
                              ))}
                            </div>
                          )}
                        {item.closeout !== null && (
                          <div>
                            <dt className="inline">Producer closeout: </dt>
                            <dd className="inline">{item.closeout.outcome}</dd>
                            {item.closeout.retainedOutputs.map((output) => (
                              <dd key={output.path} className="break-all">
                                {output.path} · {output.reason} · Remove when{" "}
                                {output.removalCondition}
                              </dd>
                            ))}
                          </div>
                        )}
                        {item.snapshot !== null && (
                          <div>
                            <dt className="inline">Snapshot: </dt>
                            <dd className="inline break-all font-mono">
                              {item.snapshot.digest}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {item.hold !== null && (
                        <p role="status" className="text-xs text-foreground">
                          Held: {item.hold.message}
                        </p>
                      )}
                      {item.grant === null && item.phase !== "removed" && (
                        <p className="text-xs text-muted-foreground">
                          Awaiting a native owner release. Administrative review
                          cannot replace it.
                        </p>
                      )}
                      {item.consumers.length > 0 && (
                        <ul
                          className="space-y-1 text-xs text-muted-foreground"
                          aria-label="Consumers"
                        >
                          {item.consumers.map((consumer) => (
                            <li key={consumer.threadId} className="break-all">
                              {consumer.threadId}:{" "}
                              {consumer.releasedAt === null
                                ? "release not recorded; settlement is checked before cleanup"
                                : "released"}
                            </li>
                          ))}
                        </ul>
                      )}
                      {item.phase === "quarantined" &&
                        item.quarantinedAt !== null && (
                          <p className="text-xs text-muted-foreground">
                            Restore is available while these files remain.
                            Permanent removal has a seven-day minimum, until{" "}
                            {new Date(
                              item.quarantinedAt + MANAGED_HOLDING_MS,
                            ).toLocaleString()}
                            .
                            {state.policy.automaticExpiry
                              ? state.policy.expiryEnabledAt === null
                                ? " Automatic expiry is held."
                                : ` Automatic expiry is no earlier than ${new Date(Math.max(item.quarantinedAt, state.policy.expiryEnabledAt) + MANAGED_HOLDING_MS).toLocaleString()}.`
                              : " Automatic expiry is off."}
                          </p>
                        )}
                      {exact !== null && (
                        <div className="flex flex-wrap gap-2">
                          {["proposed", "quarantined"].includes(item.phase) &&
                            item.grant !== null &&
                            item.reviewedAt === null && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setConfirmation({
                                    kind: "item",
                                    action: "review",
                                    item,
                                    exact,
                                  })
                                }
                              >
                                Review cleanup
                              </Button>
                            )}
                          {item.phase === "quarantined" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                setConfirmation({
                                  kind: "item",
                                  action: "restore",
                                  item,
                                  exact,
                                })
                              }
                            >
                              Restore files
                            </Button>
                          )}
                          {purge && (
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                setConfirmation({
                                  kind: "item",
                                  action: "purge",
                                  item,
                                  exact,
                                })
                              }
                            >
                              Permanently remove files
                            </Button>
                          )}
                        </div>
                      )}
                      {item.phase !== "removed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void request({
                              action: "inspect",
                              hostId: item.hostId,
                              id: item.id,
                            })
                          }
                        >
                          Inspect allocation
                        </Button>
                      )}
                    </article>
                  );
                })}
              </div>
              {selectedItems.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || selectedItems.length > 100}
                  onClick={() =>
                    void request(
                      { action: "purge-preview", items: selectedItems },
                      (next) => {
                        if (next.preview === null) {
                          setError(
                            "The permanent removal preview was unavailable. Try again.",
                          );

                          return;
                        }

                        setConfirmation({
                          kind: "batch",
                          items: selectedItems,
                          previewDigest: next.preview.digest,
                        });
                      },
                    )
                  }
                >
                  Preview {selectedItems.length} selected permanent removals
                </Button>
              )}
              {confirmation !== null && (
                <div
                  role="region"
                  aria-label="Confirm managed cleanup"
                  className="space-y-3 rounded-lg border border-border bg-muted/40 px-4 py-3"
                >
                  {confirmation.kind === "policy" ? (
                    <>
                      <h3 className="text-sm font-medium">
                        Apply managed cleanup policy?
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        The preview covers {confirmation.preview.affectedCount}{" "}
                        allocations, including{" "}
                        {confirmation.preview.quarantinedCount} quarantined and{" "}
                        {confirmation.preview.eligibleCount} currently eligible.
                      </p>
                      {confirmation.policy.automaticExpiry &&
                        !state.policy.automaticExpiry && (
                          <p className="text-xs text-foreground">
                            Existing quarantined files receive a new seven-day
                            minimum from enablement. This does not remove files
                            now.
                          </p>
                        )}
                    </>
                  ) : confirmation.kind === "batch" ? (
                    <>
                      <h3 className="text-sm font-medium">
                        Permanently remove {confirmation.items.length} selected
                        allocations?
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        This removes only the exact previewed snapshots after
                        fresh safety checks. It cannot be undone.
                      </p>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {confirmation.items.map((item) => (
                          <li
                            key={`${item.hostId}:${item.id}`}
                            className="break-all"
                          >
                            {item.hostId} · {item.id} · revision {item.revision}{" "}
                            · {item.snapshotDigest}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <>
                      <h3 className="text-sm font-medium">
                        {confirmation.action === "review"
                          ? "Approve this owner release for quarantine?"
                          : confirmation.action === "restore"
                            ? "Restore these quarantined files?"
                            : "Permanently remove these files?"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {confirmation.action === "review"
                          ? "Approval applies to this exact native owner release. Quarantine still requires current safety checks."
                          : confirmation.action === "restore"
                            ? "Restore returns the exact allocation to its original path only if that path is absent. It never overwrites files."
                            : "The seven-day holding period has passed. Fresh safety checks still apply. This cannot be undone."}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">
                        {confirmation.item.purpose} · {confirmation.item.path} ·
                        revision {confirmation.exact.revision} ·{" "}
                        {confirmation.exact.snapshotDigest}
                      </p>
                    </>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmation(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant={
                        confirmation.kind === "policy" ||
                        (confirmation.kind === "item" &&
                          confirmation.action === "restore")
                          ? "outline"
                          : "destructive"
                      }
                      size="sm"
                      disabled={busy}
                      onClick={() => void confirm()}
                    >
                      {busy
                        ? "Applying…"
                        : confirmation.kind === "policy"
                          ? "Apply managed policy"
                          : confirmation.kind === "item" &&
                              confirmation.action === "review"
                            ? "Approve quarantine"
                            : confirmation.kind === "item" &&
                                confirmation.action === "restore"
                              ? "Restore exact allocation"
                              : "Confirm permanent removal"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
