import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  definePluginApp,
  experimental_useThreadWork,
  experimental_useThreadBootstrapData,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalComposerSuggestion,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import {
  predictionSchema,
  type PredictionState,
  type rpcContract,
} from "./contract";

const OMISSION_NOT_RECORDED =
  "This prediction did not record why it omitted a reply.";

const knownPredictions = new Map<string, PredictionState>();

const predictionListeners = new Set<() => void>();

const offeredThreads = new Set<string>();

const requestingThreads = new Set<string>();

function setRequesting(threadId: string, requesting: boolean) {
  if (requestingThreads.has(threadId) === requesting) return;

  if (requesting) requestingThreads.add(threadId);
  else requestingThreads.delete(threadId);

  for (const listener of predictionListeners) listener();
}

const forceHandlers = new Map<string, Set<() => void>>();

function setRequestOffered(threadId: string, offered: boolean) {
  if (offeredThreads.has(threadId) === offered) return;

  if (offered) offeredThreads.add(threadId);
  else offeredThreads.delete(threadId);

  for (const listener of predictionListeners) listener();
}

const suggestingThreads = new Set<string>();

function setSuggesting(threadId: string, suggesting: boolean) {
  if (suggestingThreads.has(threadId) === suggesting) return;

  if (suggesting) suggestingThreads.add(threadId);
  else suggestingThreads.delete(threadId);

  for (const listener of predictionListeners) listener();
}

function handleForce(threadId: string, handler: () => void) {
  const handlers = forceHandlers.get(threadId) ?? new Set();
  handlers.add(handler);
  forceHandlers.set(threadId, handlers);

  return () => {
    handlers.delete(handler);

    if (handlers.size === 0) forceHandlers.delete(threadId);
  };
}

function forceSuggestion(threadId: string) {
  const [handler] = forceHandlers.get(threadId) ?? [];

  if (handler === undefined) toast.error("Open the chat to suggest a reply.");
  else handler();
}

function samePrediction(left: PredictionState, right: PredictionState) {
  return (
    left.generation === right.generation &&
    left.basis === right.basis &&
    left.status === right.status &&
    left.text === right.text &&
    left.noSuggestionReason === right.noSuggestionReason &&
    left.message === right.message &&
    left.archiveReadiness?.ready === right.archiveReadiness?.ready &&
    left.archiveReadiness?.reason === right.archiveReadiness?.reason &&
    left.archiveReadiness?.waitingOn === right.archiveReadiness?.waitingOn
  );
}

function rememberPrediction(next: PredictionState) {
  const current = knownPredictions.get(next.threadId);

  if (
    current !== undefined &&
    (current.generation > next.generation ||
      (current.generation === next.generation &&
        current.status !== "idle" &&
        current.status !== "predicting" &&
        (next.status === "idle" || next.status === "predicting")) ||
      samePrediction(current, next))
  )
    return;
  knownPredictions.set(next.threadId, next);

  for (const listener of predictionListeners) listener();
}

function rememberPayload(payload: unknown) {
  const event = predictionSchema.safeParse(payload);

  if (event.success) rememberPrediction(event.data);

  return event.success;
}

function subscribePredictions(listener: () => void) {
  predictionListeners.add(listener);

  return () => {
    predictionListeners.delete(listener);
  };
}

function reportFailure() {
  console.warn("Composer prediction could not reach Omnyo.");
}

function usePrediction(threadId: string) {
  const bootstrap = experimental_useThreadBootstrapData(threadId, "state");

  const bootstrapResult =
    bootstrap.status === "ready" ? bootstrap.result : null;

  const bootstrapped = useMemo(() => {
    const parsed = predictionSchema.safeParse(bootstrapResult);

    return parsed.success && parsed.data.threadId === threadId
      ? parsed.data
      : null;
  }, [bootstrapResult, threadId]);

  const stored = useSyncExternalStore(
    subscribePredictions,
    () => knownPredictions.get(threadId) ?? null,
  );

  useEffect(() => {
    if (bootstrapped !== null) rememberPrediction(bootstrapped);
  }, [bootstrapped]);

  const state =
    bootstrapped !== null &&
    (stored === null || bootstrapped.generation > stored.generation)
      ? bootstrapped
      : stored;

  return { state, bootstrapSettled: bootstrap.status !== "pending" };
}

type WorkSummary = NonNullable<PluginSidebarThread["experimental_work"]>;

function ThreadPrediction({
  threadId,
  work,
}: {
  threadId: string;
  work: WorkSummary | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { state, bootstrapSettled } = usePrediction(threadId);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const hasConnected = useRef(connection === "connected");

  const incomplete =
    state === null || state.status === "idle" || state.status === "predicting";

  const reconciled = useRef(false);

  useRealtime("predictions-changed", rememberPayload);

  useEffect(() => {
    if (!incomplete) {
      reconciled.current = true;

      return;
    }

    if (reconciled.current) return;

    const read = () => {
      reconciled.current = true;
      void rpc
        .call("state", { threadId })
        .then(rememberPrediction, reportFailure);
    };

    const timer = bootstrapSettled ? null : setTimeout(read, 1500);

    if (bootstrapSettled) read();

    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [bootstrapSettled, incomplete, rpc, threadId]);

  useEffect(() => {
    const reconnected =
      (hasConnected.current || incomplete) &&
      previousConnection.current !== "connected" &&
      connection === "connected";

    previousConnection.current = connection;

    if (connection === "connected") hasConnected.current = true;

    if (!reconnected) return;
    void rpc
      .call("state", { threadId })
      .then(rememberPrediction, reportFailure);
  }, [connection, incomplete, rpc, threadId]);

  useEffect(
    () =>
      composer.onSubmitted(() => {
        const submitted = knownPredictions.get(threadId);

        if (submitted === undefined) return;
        rememberPrediction(withoutSuggestion(submitted, "idle"));
      }),
    [composer, threadId],
  );

  const [forcing, setForcing] = useState(false);
  const latestForce = useRef(0);

  const settle = useCallback(
    (method: "cancel" | "dismiss") => {
      latestForce.current += 1;
      setForcing(false);
      setRequesting(threadId, false);

      if (state === null) return;
      rememberPrediction(
        withoutSuggestion(state, method === "cancel" ? "idle" : "none"),
      );
      void rpc
        .call(method, { threadId, generation: state.generation })
        .then(rememberPrediction, reportFailure);
    },
    [rpc, state, threadId],
  );

  const force = useCallback(() => {
    if (
      requestingThreads.has(threadId) ||
      knownPredictions.get(threadId)?.status === "predicting"
    )
      return;
    setRequesting(threadId, true);
    latestForce.current += 1;
    const attempt = latestForce.current;
    setForcing(true);
    void rpc.call("request", { threadId, force: true }).then(
      (next) => {
        rememberPrediction(next);

        if (latestForce.current !== attempt) return;
        setForcing(false);
        setRequesting(threadId, false);

        if (next.status === "idle" && next.message !== null)
          toast.error(next.message);
      },
      () => {
        if (latestForce.current !== attempt) return;
        setForcing(false);
        setRequesting(threadId, false);
        toast.error("Couldn’t request a suggested reply.");
      },
    );
  }, [rpc, threadId]);

  const retry = useCallback(() => {
    if (state?.forced === true) return force();
    void rpc
      .call("request", { threadId })
      .then(rememberPrediction, reportFailure);
  }, [force, rpc, state?.forced, threadId]);

  useEffect(() => handleForce(threadId, force), [force, threadId]);

  useEffect(() => () => setRequesting(threadId, false), [threadId]);

  const available = !composer.isRunning && !composer.isSubmitting;

  const currentPrediction =
    state?.status === "ready" &&
    work !== null &&
    state.basis === work.basis &&
    work.requiredInput.length === 0
      ? state
      : null;

  const hasText = Boolean(currentPrediction?.text?.trim());

  const ownedWork =
    work !== null && (work.activity.length > 0 || work.waits.length > 0);

  const currentText =
    hasText && (currentPrediction?.forced === true || !ownedWork)
      ? (currentPrediction?.text ?? null)
      : null;

  const status = state?.status ?? null;
  const message = state?.message ?? null;
  const canRequestPrediction = state?.sameChat !== true;

  const omissionReason =
    currentPrediction !== null &&
    !hasText &&
    (currentPrediction.forced === true ||
      (work?.primary.label !== "external" &&
        work?.primary.label !== "ready-to-archive"))
      ? (currentPrediction.noSuggestionReason ?? OMISSION_NOT_RECORDED)
      : null;

  const suggestion = useMemo((): ExperimentalComposerSuggestion | null => {
    if (!available) return null;

    if (forcing || status === "predicting")
      return { status: "loading", onDismiss: () => settle("cancel") };

    if (currentText !== null)
      return {
        status: "ready",
        text: currentText,
        onDismiss: () => settle("dismiss"),
        ...(canRequestPrediction ? { onRegenerate: force } : {}),
      };

    if (status === "failed" && canRequestPrediction)
      return {
        status: "failed",
        message: message ?? "Prediction unavailable.",
        onRetry: retry,
        onDismiss: () => settle("dismiss"),
      };

    if (omissionReason !== null && canRequestPrediction)
      return {
        status: "none",
        reason: omissionReason,
        onRequest: force,
        onDismiss: () => settle("dismiss"),
      };

    return null;
  }, [
    available,
    canRequestPrediction,
    currentText,
    force,
    forcing,
    message,
    omissionReason,
    retry,
    settle,
    status,
  ]);

  useEffect(() => {
    try {
      composer.experimental_setSuggestion(suggestion);
    } catch {
      console.warn("Reload this window to show the composer prediction.");
      composer.experimental_setSuggestion(null);
    }
  }, [composer, suggestion]);

  const compactViewport = useIsCompactViewport();

  const suggesting =
    suggestion !== null && (suggestion.status === "ready" || compactViewport);

  useEffect(() => {
    setSuggesting(threadId, suggesting);

    return () => setSuggesting(threadId, false);
  }, [suggesting, threadId]);

  const requestOffered =
    available &&
    canRequestPrediction &&
    status !== null &&
    status !== "disabled" &&
    (work === null || work.requiredInput.length === 0);

  useEffect(() => {
    setRequestOffered(threadId, requestOffered);

    return () => setRequestOffered(threadId, false);
  }, [requestOffered, threadId]);

  return null;
}

function withoutSuggestion(
  state: PredictionState,
  status: "idle" | "none",
): PredictionState {
  return {
    ...state,
    generation: state.generation + 1,
    status,
    text: null,
    noSuggestionReason: null,
    message: null,
    archiveReadiness: status === "none" ? state.archiveReadiness : null,
  };
}

function PredictionBanner() {
  const composer = useComposer();

  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;

  const work = experimental_useThreadWork(threadId);

  if (threadId === null) return null;

  return <ThreadPrediction key={threadId} threadId={threadId} work={work} />;
}

function SuggestReplyAction() {
  const composer = useComposer();

  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;

  const offered = useSyncExternalStore(
    subscribePredictions,
    () => threadId !== null && offeredThreads.has(threadId),
  );

  const suggestionShown = useSyncExternalStore(
    subscribePredictions,
    () =>
      threadId !== null &&
      (suggestingThreads.has(threadId) ||
        requestingThreads.has(threadId) ||
        knownPredictions.get(threadId)?.status === "predicting"),
  );

  if (threadId === null || !offered || suggestionShown || !composer.isEmpty)
    return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Suggest a reply"
            className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => forceSuggestion(threadId)}
          >
            <Icon name="Sparkles" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Suggest a reply</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PredictionSync() {
  useRealtime("predictions-changed", (payload) => {
    if (!rememberPayload(payload))
      console.warn("Composer prediction received an invalid update.");
  });

  return null;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "predictions",
    scopes: ["thread"],
    banners: [
      {
        id: "suggestion",
        chrome: "bare",
        experimental_placement: "adjacent-to-composer",
        component: PredictionBanner,
      },
    ],
    actions: [{ id: "suggest-reply", component: SuggestReplyAction }],
  });
  app.commands.register({
    id: "suggest-reply",
    title: "Suggest a reply",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) forceSuggestion(threadId);
    },
  });
  app.slots.experimental_appOverlay({
    id: "prediction-sync",
    component: PredictionSync,
  });
});
