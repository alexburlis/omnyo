import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface MobilePendingInteractionOwner {
  activeId: string | null;
  register: (id: string, expandedByDefault: boolean) => () => void;
  open: (id: string) => void;
  minimize: (id: string) => void;
}

const MobilePendingInteractionContext =
  createContext<MobilePendingInteractionOwner | null>(null);

export function MobilePendingInteractionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const minimize = useCallback((id: string) => {
    setActiveId((current) => (current === id ? null : current));
  }, []);

  const register = useCallback(
    (id: string, expandedByDefault: boolean) => {
      if (expandedByDefault) setActiveId((current) => current ?? id);

      return () => minimize(id);
    },
    [minimize],
  );

  const open = useCallback((id: string) => setActiveId(id), []);

  const owner = useMemo(
    () => ({ activeId, register, open, minimize }),
    [activeId, register, open, minimize],
  );

  return (
    <MobilePendingInteractionContext.Provider value={owner}>
      {children}
    </MobilePendingInteractionContext.Provider>
  );
}

export function useMobilePendingInteraction({
  enabled,
  expandedByDefault,
  interactionKey,
}: {
  enabled: boolean;
  expandedByDefault: boolean;
  interactionKey?: string;
}) {
  const owner = useContext(MobilePendingInteractionContext);
  const shellId = useId();

  const id =
    interactionKey === undefined ? shellId : `${shellId}:${interactionKey}`;

  const [localOpen, setLocalOpen] = useState(expandedByDefault);
  const register = owner?.register;
  const open = owner?.open;
  const minimize = owner?.minimize;

  useLayoutEffect(() => {
    if (!enabled) return;

    if (register) return register(id, expandedByDefault);

    if (expandedByDefault) setLocalOpen(true);
  }, [enabled, expandedByDefault, id, register]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open && minimize) {
        if (next) open(id);
        else minimize(id);
      } else setLocalOpen(next);
    },
    [id, minimize, open],
  );

  return { isOpen: owner ? owner.activeId === id : localOpen, setOpen };
}
