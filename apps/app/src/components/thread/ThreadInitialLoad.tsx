import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { isRecentPendingChatHandoff } from "@/lib/pending-chat-creations";

const SUPPORTING_DATA_WAIT_MS = 1_000;

const HANDOFF_ENTRANCE_MS = MOTION_DURATION_MS.base + MOTION_DURATION_MS.fast;

function createInitialLoad(initiallyReady = false) {
  const listeners = new Set<() => void>();
  let conversation = 0;
  let supporting = 0;
  let supportingExpired = false;
  let started = false;
  let revealed = initiallyReady;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const blocking = () => conversation + (supportingExpired ? 0 : supporting);

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: blocking,
    isRevealed: () => revealed,
    hasStarted: () => started,
    begin(holdsConversation = false) {
      if (revealed) return () => {};

      started = true;

      if (holdsConversation) conversation += 1;
      else supporting += 1;
      notify();
      let finished = false;

      return () => {
        if (finished) return;
        finished = true;

        if (holdsConversation) conversation -= 1;
        else supporting -= 1;
        notify();
      };
    },
    expireSupportingData() {
      if (supportingExpired) return;
      supportingExpired = true;
      notify();
    },
    reveal() {
      if (blocking() !== 0) return false;
      revealed = true;
      notify();

      return true;
    },
  };
}

const InitialLoadContext = createContext<ReturnType<
  typeof createInitialLoad
> | null>(null);

const threadLoads = new Map<
  string,
  Set<ReturnType<typeof createInitialLoad>>
>();

export function beginThreadInitialLoad(input: unknown) {
  if (typeof input !== "object" || input === null) return () => {};

  const threadId = Reflect.get(input, "threadId");

  if (typeof threadId !== "string") return () => {};

  const finishes = [...(threadLoads.get(threadId) ?? [])].map((load) =>
    load.begin(),
  );

  return () => {
    for (const finish of finishes) finish();
  };
}

export function useThreadInitialLoad() {
  return useContext(InitialLoadContext);
}

const subscribeNothing = () => () => {};

const alwaysRevealed = () => true;

export function useThreadInitialLoadRevealed() {
  const load = useThreadInitialLoad();

  return useSyncExternalStore(
    load?.subscribe ?? subscribeNothing,
    load?.isRevealed ?? alwaysRevealed,
  );
}

export function useThreadInitialLoadPending(
  pending: boolean,
  holdsConversation = false,
) {
  const load = useThreadInitialLoad();
  useLayoutEffect(
    () => (pending ? load?.begin(holdsConversation) : undefined),
    [holdsConversation, load, pending],
  );
}

export function InitialLoadSurface({
  threadId,
  children,
  fallback,
  initiallyReady = false,
}: {
  threadId?: string;
  children: ReactNode;
  fallback: ReactNode;
  initiallyReady?: boolean;
}) {
  const [load] = useState(() => createInitialLoad(initiallyReady));
  const pending = useSyncExternalStore(load.subscribe, load.snapshot);
  const [revealed, setRevealed] = useState(initiallyReady);

  const [handoff, setHandoff] = useState(
    () => threadId !== undefined && isRecentPendingChatHandoff(threadId),
  );

  useEffect(() => {
    if (!handoff) return;
    const timer = setTimeout(() => setHandoff(false), HANDOFF_ENTRANCE_MS);

    return () => clearTimeout(timer);
  }, [handoff]);
  useLayoutEffect(() => {
    if (threadId === undefined) return;
    let loads = threadLoads.get(threadId);

    if (loads === undefined) {
      loads = new Set();
      threadLoads.set(threadId, loads);
    }

    loads.add(load);

    return () => {
      loads.delete(load);

      if (loads.size === 0) threadLoads.delete(threadId);
    };
  }, [load, threadId]);

  useEffect(() => {
    if (threadId === undefined) return;

    const timer = setTimeout(
      () => load.expireSupportingData(),
      SUPPORTING_DATA_WAIT_MS,
    );

    return () => clearTimeout(timer);
  }, [load, threadId]);

  useEffect(() => {
    if (revealed || pending !== 0) return;

    if (threadId === undefined && !load.hasStarted() && load.reveal()) {
      setRevealed(true);

      return;
    }

    let secondFrame: number | undefined;

    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (load.reveal()) setRevealed(true);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);

      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [load, pending, revealed, threadId]);

  return (
    <InitialLoadContext.Provider value={load}>
      <div
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
        aria-busy={!revealed}
        data-thread-initial-load={threadId}
        data-thread-handoff={handoff ? "" : undefined}
      >
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
          style={{ visibility: revealed ? undefined : "hidden" }}
        >
          {children}
        </div>
        {revealed ? null : (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {fallback}
          </div>
        )}
      </div>
    </InitialLoadContext.Provider>
  );
}

export function ThreadInitialLoad(props: {
  threadId: string;
  children: ReactNode;
  fallback: ReactNode;
  initiallyReady?: boolean;
}) {
  return <InitialLoadSurface {...props} />;
}
