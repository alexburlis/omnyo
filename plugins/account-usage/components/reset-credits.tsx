import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "../contract.ts";
import {
  codexRedeemResetInputSchema,
  type CodexRedeemReset,
  type CodexResetCredits,
} from "../lib/codex-reset-contract.ts";
import { z } from "zod";
import {
  cachedResetCredits,
  invalidateResetCredits,
  loadResetCredits,
  resetCreditsExpiry,
} from "./reset-credits-cache.ts";
import {
  ROW_ACTION_CLASS as BUTTON_CLASS,
  ROW_PRIMARY_ACTION_CLASS,
  ROW_QUIET_ACTION_CLASS,
} from "./action-classes.ts";

const savedAttemptSchema = codexRedeemResetInputSchema
  .omit({ confirmed: true })
  .extend({ confirmed: z.literal(true).default(true) });

type PendingAttempt = z.infer<typeof savedAttemptSchema>;

const RESULT_TEXT: Record<CodexRedeemReset["code"], string> = {
  reset: "Usage reset applied.",
  already_redeemed: "Reset already applied.",
  no_credit: "No reset credit available.",
  nothing_to_reset: "No usage limit needs resetting.",
};

function readAttempt(accountId: string) {
  try {
    const saved = sessionStorage.getItem(`account-usage:reset:${accountId}`);

    if (saved === null) return { pending: null, error: null };
    const pending = savedAttemptSchema.parse(JSON.parse(saved));

    if (pending.accountId !== accountId)
      throw new Error("Saved account mismatch");

    return { pending, error: null };
  } catch {
    return { pending: null, error: "Saved reset attempt could not be read." };
  }
}

export function ResetCredits({
  accountId,
  accountName,
  now,
  onUsageChanged,
  refreshRevision,
}: {
  accountId: string;
  accountName: string;
  now: number;
  onUsageChanged: () => Promise<void>;
  refreshRevision: number;
}): React.ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const [recovered] = useState(() => readAttempt(accountId));

  const [pending, setPending] = useState<PendingAttempt | null>(
    recovered.pending,
  );

  const [storageFailure, setStorageFailure] = useState<string | null>(
    recovered.error,
  );

  const [credits, setCredits] = useState<CodexResetCredits | null>(() =>
    cachedResetCredits(accountId),
  );

  const [listFailure, setListFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CodexRedeemReset | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const busy = useRef(false);
  const reading = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const loadCredits = useCallback(async () => {
    const request = ++reading.current;
    setLoading(true);

    try {
      const next = await loadResetCredits(accountId, () =>
        rpc.call("codexResetCredits", { accountId }),
      );

      if (!mounted.current || reading.current !== request) return;
      setCredits(next);
      setListFailure(null);
    } catch (error) {
      if (mounted.current && reading.current === request)
        setListFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current && reading.current === request) setLoading(false);
    }
  }, [rpc, accountId]);

  useEffect(() => {
    void loadCredits();
  }, [loadCredits, refreshRevision]);

  useEffect(() => {
    const expiresAt = resetCreditsExpiry(accountId);

    if (expiresAt === null || expiresAt <= Date.now()) return;
    const timer = setTimeout(() => void loadCredits(), expiresAt - Date.now());

    return () => clearTimeout(timer);
  }, [accountId, credits, loadCredits, refreshRevision]);

  const redeem = async (attempt: PendingAttempt) => {
    if (busy.current) return;
    busy.current = true;
    setResetting(true);
    setRequestFailure(null);

    let acknowledged: CodexRedeemReset;

    try {
      acknowledged = await rpc.call("codexRedeemReset", attempt);
    } catch (error) {
      if (mounted.current) {
        setRequestFailure(
          error instanceof Error ? error.message : String(error),
        );
        setResetting(false);
      }

      busy.current = false;

      return;
    }

    try {
      sessionStorage.removeItem(`account-usage:reset:${accountId}`);
    } catch {
      if (mounted.current)
        setStorageFailure(
          "Reset result received; saved attempt could not be cleared.",
        );
    }

    invalidateResetCredits(accountId);

    if (mounted.current) {
      setPending(null);
      setSelected(null);
      setResult(acknowledged);
      await loadCredits();
      await onUsageChanged();
      setResetting(false);
    }

    busy.current = false;
  };

  const confirm = () => {
    if (
      busy.current ||
      pending !== null ||
      selected === null ||
      storageFailure !== null
    )
      return;
    const saved = readAttempt(accountId);

    if (saved.error !== null) {
      setStorageFailure(saved.error);

      return;
    }

    if (saved.pending !== null) {
      setPending(saved.pending);
      setSelected(null);

      return;
    }

    const attempt: PendingAttempt = {
      accountId,
      creditId: selected,
      redeemRequestId: crypto.randomUUID(),
      confirmed: true,
    };

    try {
      sessionStorage.setItem(
        `account-usage:reset:${accountId}`,
        JSON.stringify(attempt),
      );
    } catch {
      setStorageFailure("Could not save the reset attempt. No reset was sent.");

      return;
    }

    setPending(attempt);
    setResult(null);
    void redeem(attempt);
  };

  const usable = (credits?.credits ?? [])
    .filter(
      (credit) =>
        credit.status === "available" &&
        (credit.expiresAt === null || Date.parse(credit.expiresAt) > now),
    )
    .sort(
      (left, right) =>
        (left.expiresAt === null ? Infinity : Date.parse(left.expiresAt)) -
        (right.expiresAt === null ? Infinity : Date.parse(right.expiresAt)),
    );

  const nextExpiry = usable[0]?.expiresAt ?? null;

  return (
    <div
      className="flex flex-col gap-1 text-2xs leading-tight has-[>:not(.sr-only)]:mt-1"
      aria-label={`Reset credits for ${accountName}`}
      role="group"
    >
      {listFailure !== null ? (
        <span className="flex items-center gap-1">
          <span role="alert" className="min-w-0 flex-1 text-destructive-text">
            {listFailure}
          </span>
          <button
            type="button"
            className={BUTTON_CLASS}
            aria-label="Refresh reset credits"
            disabled={loading || resetting}
            onClick={() => void loadCredits()}
          >
            Retry
          </button>
        </span>
      ) : null}
      {storageFailure !== null ? (
        <p role="alert" className="m-0 text-destructive-text">
          {storageFailure}
        </p>
      ) : null}
      {result !== null ? (
        <p role="status" className="m-0 text-sidebar-foreground">
          {RESULT_TEXT[result.code]}
        </p>
      ) : null}
      {result?.usageRefreshError ? (
        <p role="alert" className="m-0 text-warning-text">
          {result.usageRefreshError}
        </p>
      ) : null}
      {pending !== null ? (
        <span className="flex items-center gap-1">
          <span className="min-w-0 flex-1 text-warning-text">
            {resetting
              ? "Reset request in progress."
              : "Reset outcome unknown. Retry the same reset."}
            {requestFailure !== null ? (
              <span role="alert" className="block text-destructive-text">
                {requestFailure}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={resetting || storageFailure !== null}
            onClick={() => void redeem(pending)}
          >
            {resetting ? "Resetting…" : "Retry same reset"}
          </button>
        </span>
      ) : selected !== null ? (
        <span className="flex items-center gap-1">
          <span className="min-w-0 flex-1 text-sidebar-foreground">
            Use one reset for {accountName}?
          </span>
          <button
            type="button"
            className={ROW_PRIMARY_ACTION_CLASS}
            disabled={loading || resetting || storageFailure !== null}
            onClick={confirm}
          >
            Confirm reset
          </button>
          <button
            type="button"
            className={ROW_QUIET_ACTION_CLASS}
            onClick={() => setSelected(null)}
          >
            Cancel
          </button>
        </span>
      ) : listFailure !== null && credits === null ? null : credits === null ? (
        <span className="sr-only">Checking resets…</span>
      ) : usable.length === 0 ? (
        <span className="sr-only">No reset credits available.</span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-subtle-foreground">
            {usable.length} reset{usable.length === 1 ? "" : "s"} available
            {nextExpiry === null
              ? ""
              : ` · ${usable.length === 1 ? "expires" : "next expires"} ${new Date(nextExpiry).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
          </span>
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={
              loading ||
              resetting ||
              storageFailure !== null ||
              listFailure !== null
            }
            onClick={() => {
              setSelected(usable[0]!.id);
              setResult(null);
            }}
          >
            Use reset
          </button>
        </span>
      )}
    </div>
  );
}
