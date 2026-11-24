import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import {
  BugReportDialogHost,
  bugReportDialogOpenAtom,
} from "@/components/dialogs/BugReportDialog";
import {
  usePluginSidebarFooterDisclosure,
  type BuiltinFooterAction,
} from "@/components/plugin/PluginSidebarFooterItems";
import { SIDEBAR_FOOTER_MORE_ID } from "./sidebarFooterPreferences";

export interface SidebarFooterState {
  disclosure: ReturnType<typeof usePluginSidebarFooterDisclosure>;
  isCustomizing: boolean;
  isNavigationCustomizing: boolean;
  setNavigationCustomizing: (isOpen: boolean) => void;
  startCustomizing: () => void;
  finishCustomizing: () => void;
  closeCustomizing: () => void;
}

const SidebarFooterStateContext = createContext<SidebarFooterState | null>(
  null,
);

function OwnedSidebarFooterStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { activeItem, activeKey, close, dismiss, handleCommand } =
    usePluginSidebarFooterDisclosure();

  const disclosure = useMemo(
    () => ({ activeItem, activeKey, close, dismiss, handleCommand }),
    [activeItem, activeKey, close, dismiss, handleCommand],
  );

  const [isCustomizing, setCustomizing] = useState(false);
  const [isNavigationCustomizing, setNavigationCustomizing] = useState(false);

  const startCustomizing = useCallback(() => {
    dismiss();
    setNavigationCustomizing(false);
    setCustomizing(true);
  }, [dismiss]);

  const finishCustomizing = useCallback(() => {
    flushSync(() => setCustomizing(false));
    document.getElementById(SIDEBAR_FOOTER_MORE_ID)?.focus();
  }, []);

  const closeCustomizing = useCallback(() => setCustomizing(false), []);

  const value = useMemo(
    () => ({
      disclosure,
      isCustomizing,
      isNavigationCustomizing,
      setNavigationCustomizing,
      startCustomizing,
      finishCustomizing,
      closeCustomizing,
    }),
    [
      closeCustomizing,
      disclosure,
      finishCustomizing,
      isCustomizing,
      isNavigationCustomizing,
      startCustomizing,
    ],
  );

  return (
    <SidebarFooterStateContext.Provider value={value}>
      {children}
      <BugReportDialogHost />
    </SidebarFooterStateContext.Provider>
  );
}

export function SidebarFooterStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const parent = useContext(SidebarFooterStateContext);

  if (parent !== null) return children;

  return (
    <OwnedSidebarFooterStateProvider>
      {children}
    </OwnedSidebarFooterStateProvider>
  );
}

export function useSidebarFooterState(): SidebarFooterState {
  const state = useContext(SidebarFooterStateContext);

  if (state === null) {
    throw new Error(
      "useSidebarFooterState must be used inside SidebarFooterStateProvider",
    );
  }

  return state;
}

export function useSidebarFooterBuiltInActions(
  beforeActivate: () => void,
): readonly BuiltinFooterAction[] {
  const navigate = useNavigate();
  const setBugReportOpen = useSetAtom(bugReportDialogOpenAtom);

  return useMemo(
    () => [
      {
        id: "mobile",
        href: "/settings/mobile",
        onActivate: () => {
          beforeActivate();
          void navigate("/settings/mobile");
        },
      },
      {
        id: "report-bug",
        onActivate: () => {
          beforeActivate();
          setBugReportOpen(true);
        },
      },
    ],
    [beforeActivate, navigate, setBugReportOpen],
  );
}
