import { createContext, useContext, useState, type ReactNode } from "react";
import { ActionHistory } from "@/lib/action-history";

const ActionHistoryContext = createContext<ActionHistory | null>(null);

export function ActionHistoryProvider({ children }: { children: ReactNode }) {
  const [history] = useState(() => new ActionHistory());

  return (
    <ActionHistoryContext.Provider value={history}>
      {children}
    </ActionHistoryContext.Provider>
  );
}

export function useActionHistory(): ActionHistory {
  const history = useContext(ActionHistoryContext);

  if (history === null) {
    throw new Error(
      "useActionHistory must be used within an <ActionHistoryProvider>",
    );
  }

  return history;
}
