import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const ReasoningExpansionContext = createContext<Map<string, boolean> | null>(
  null,
);

const sessionOverridesByThread = new Map<string, Map<string, boolean>>();

function sessionOverridesForThread(
  threadId: string | undefined,
): Map<string, boolean> {
  if (threadId === undefined) return new Map();

  const existing = sessionOverridesByThread.get(threadId);

  if (existing) return existing;

  const created = new Map<string, boolean>();
  sessionOverridesByThread.set(threadId, created);

  return created;
}

export function TimelineReasoningExpansionProvider({
  children,
  threadId,
}: {
  children: ReactNode;
  threadId?: string;
}) {
  const [overrides] = useState(() => sessionOverridesForThread(threadId));

  return (
    <ReasoningExpansionContext.Provider value={overrides}>
      {children}
    </ReasoningExpansionContext.Provider>
  );
}

export function useTimelineReasoningExpansion(key: string | undefined) {
  const overrides = useContext(ReasoningExpansionContext);

  const [expanded, setExpanded] = useState<boolean | null>(() =>
    key === undefined ? null : (overrides?.get(key) ?? null),
  );

  const setOverride = useCallback(
    (value: boolean) => {
      if (key !== undefined) overrides?.set(key, value);
      setExpanded(value);
    },
    [key, overrides],
  );

  return [expanded, setOverride] as const;
}
