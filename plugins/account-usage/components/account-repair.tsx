import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type {
  AccountRow,
  SignInResult,
  SignInStart,
  rpcContract,
} from "../contract.ts";
import { accountProblem, rpcErrorText } from "../lib/account-problem.ts";
import {
  ROW_ACTION_CLASS as BUTTON_CLASS,
  ROW_PRIMARY_ACTION_CLASS,
  ROW_QUIET_ACTION_CLASS as QUIET_BUTTON_CLASS,
} from "./action-classes.ts";

const DONE_VISIBLE_MS = 6_000;

type SignInStep =
  | { step: "starting" }
  | ({ step: "codex" } & SignInStart)
  | { step: "done"; usageRefreshError: string | null }
  | { step: "failed"; message: string };

export type SignInState = { accountId: string } & SignInStep;

export interface AccountSignIn {
  state: SignInState | null;
  start: (accountId: string) => void;
  cancel: () => void;
  openPage: () => void;
}

export function useAccountSignIn(
  onUsageChanged: () => Promise<void>,
): AccountSignIn {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = experimental_useAppNavigate();
  const [state, setState] = useState<SignInState | null>(null);
  const attempt = useRef(0);
  const current = useRef<SignInState | null>(null);

  const update = useCallback((next: SignInState | null) => {
    current.current = next;
    setState(next);
  }, []);

  const settle = useCallback(
    (id: number, accountId: string, result: SignInResult) => {
      if (attempt.current !== id) return;

      if (result.status === "complete") {
        update({
          accountId,
          step: "done",
          usageRefreshError: result.usageRefreshError,
        });
        void onUsageChanged();
      } else if (result.status === "error") {
        update({ accountId, step: "failed", message: result.message });
      }
    },
    [onUsageChanged, update],
  );

  const cancel = useCallback(() => {
    const active = current.current;
    attempt.current += 1;

    if (active?.step === "codex")
      void rpc
        .call("signInCancel", { sessionId: active.sessionId })
        .catch(() => undefined);
    update(null);
  }, [rpc, update]);

  const start = useCallback(
    (accountId: string) => {
      cancel();
      const id = attempt.current;
      update({ accountId, step: "starting" });

      void rpc.call("signInStart", { accountId }).then(
        (started) => {
          if (attempt.current !== id) return;

          update({ accountId, step: "codex", ...started });
        },
        (error: unknown) => {
          if (attempt.current === id)
            update({ accountId, step: "failed", message: rpcErrorText(error) });
        },
      );
    },
    [cancel, rpc, update],
  );

  const openPage = useCallback(() => {
    const active = current.current;

    if (active?.step === "codex") {
      void experimental_copyToClipboard({ text: active.userCode });
      navigate.openUrl(active.verificationUri);
    }
  }, [navigate]);

  const codex = state?.step === "codex" ? state : null;
  const codexAccountId = codex?.accountId ?? null;
  const codexSessionId = codex?.sessionId ?? null;
  const codexIntervalMs = codex?.intervalMs ?? null;

  useEffect(() => {
    if (
      codexAccountId === null ||
      codexSessionId === null ||
      codexIntervalMs === null
    )
      return;
    const id = attempt.current;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      let result: SignInResult;

      try {
        result = await rpc.call("signInPoll", {
          accountId: codexAccountId,
          sessionId: codexSessionId,
        });
      } catch (error) {
        result = { status: "error", message: rpcErrorText(error) };
      }

      if (attempt.current !== id) return;

      if (result.status === "pending")
        timer = setTimeout(() => void poll(), codexIntervalMs);
      else settle(id, codexAccountId, result);
    };

    timer = setTimeout(() => void poll(), codexIntervalMs);

    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexAccountId, codexIntervalMs, codexSessionId, rpc, settle]);

  const doneAccountId = state?.step === "done" ? state.accountId : null;

  useEffect(() => {
    if (doneAccountId === null) return;
    const id = attempt.current;

    const timer = setTimeout(() => {
      if (attempt.current === id) update(null);
    }, DONE_VISIBLE_MS);

    return () => clearTimeout(timer);
  }, [doneAccountId, update]);

  const cancelOnUnmount = useRef(cancel);

  useEffect(() => {
    cancelOnUnmount.current = cancel;
  }, [cancel]);

  useEffect(() => () => cancelOnUnmount.current(), []);

  return { state, start, cancel, openPage };
}

function SignInFlow({
  state,
  accountName,
  signIn,
}: {
  state: SignInState;
  accountName: string;
  signIn: AccountSignIn;
}): React.ReactElement {
  if (state.step === "starting") {
    return (
      <span role="status" className="text-subtle-foreground">
        Opening sign-in…
      </span>
    );
  }

  if (state.step === "done") {
    return (
      <span role="status" className="flex flex-col gap-0.5">
        <span className="text-success-foreground">Signed in again.</span>
        {state.usageRefreshError === null ? null : (
          <span className="text-warning-text">
            Usage refresh failed: {state.usageRefreshError}
          </span>
        )}
      </span>
    );
  }

  if (state.step === "failed") {
    return (
      <span className="flex items-center gap-1.5">
        <span
          role="alert"
          className="min-w-0 flex-1 truncate text-destructive-text"
          title={state.message}
        >
          Sign-in failed · {state.message}
        </span>
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={() => signIn.start(state.accountId)}
        >
          Try again
        </button>
        <button
          type="button"
          className={QUIET_BUTTON_CLASS}
          onClick={signIn.cancel}
        >
          Dismiss
        </button>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-sidebar-foreground">
          Enter{" "}
          <span className="font-mono font-semibold tracking-wider select-all">
            {state.userCode}
          </span>{" "}
          on the OpenAI page
        </span>
        <button
          type="button"
          className={ROW_PRIMARY_ACTION_CLASS}
          onClick={signIn.openPage}
        >
          Copy &amp; open
        </button>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          role="status"
          className="min-w-0 flex-1 truncate text-subtle-foreground"
        >
          Waiting for {accountName}…
        </span>
        <button
          type="button"
          className={QUIET_BUTTON_CLASS}
          onClick={signIn.cancel}
        >
          Cancel
        </button>
      </span>
    </span>
  );
}

function RetryButton({
  accountId,
  onUsageChanged,
}: {
  accountId: string;
  onUsageChanged: () => Promise<void>;
}): React.ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const retry = async () => {
    setRetrying(true);
    setFailure(null);

    try {
      await rpc.call("refreshAccount", { accountId });
      await onUsageChanged();
    } catch (error) {
      if (mounted.current) setFailure(rpcErrorText(error));
    } finally {
      if (mounted.current) setRetrying(false);
    }
  };

  return (
    <>
      {failure === null ? null : (
        <span role="alert" className="sr-only">
          Retry failed: {failure}
        </span>
      )}
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={retrying}
        title={failure === null ? undefined : `Retry failed: ${failure}`}
        onClick={() => void retry()}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </>
  );
}

export function signedOut(row: AccountRow): boolean {
  return (
    row.status === "error" &&
    row.error !== null &&
    accountProblem(row.error, row.canSignInAgain).kind === "signed-out"
  );
}

export function AccountRepair({
  row,
  accountName,
  signIn,
  onUsageChanged,
}: {
  row: AccountRow;
  accountName: string;
  signIn: AccountSignIn;
  onUsageChanged: () => Promise<void>;
}): React.ReactElement | null {
  const flow = signIn.state?.accountId === row.id ? signIn.state : null;

  if (flow !== null) {
    return (
      <div
        role="group"
        aria-label={`Sign in again to ${accountName}`}
        className="mt-1 flex flex-col text-2xs leading-tight"
      >
        <SignInFlow state={flow} accountName={accountName} signIn={signIn} />
      </div>
    );
  }

  if (row.status !== "error" || row.error === null) return null;
  const problem = accountProblem(row.error, row.canSignInAgain);

  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1.5 text-2xs leading-4">
      <Icon
        name="AlertCircle"
        aria-hidden="true"
        className="mt-px size-3 shrink-0 text-destructive-text"
      />
      <span className="min-w-0 flex-1 break-words" title={problem.raw}>
        <span className="font-medium text-destructive-text">
          {problem.title}
        </span>
        <span className="text-muted-foreground"> · {problem.detail}</span>
      </span>
      {problem.kind === "signed-out" ? (
        <button
          type="button"
          className={ROW_PRIMARY_ACTION_CLASS}
          onClick={() => signIn.start(row.id)}
        >
          Sign in again
        </button>
      ) : row.nativeProfile ? null : (
        <RetryButton accountId={row.id} onUsageChanged={onUsageChanged} />
      )}
    </div>
  );
}
