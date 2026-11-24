import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appCommandTarget } from "@/lib/app-command-targets";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { useIsSidebarFramed } from "@/components/ui/sidebar.js";
import { TITLE_BAR_SEGMENT_CLASS } from "./title-bar-segment";

interface WindowRightPanelRegistration {
  token: symbol;
  isOpen: boolean;
}

const windowRightPanelRegistrationsAtom = atom<
  readonly WindowRightPanelRegistration[]
>([]);

function preloadRightPanel(): void {
  void import("@/components/secondary-panel/lazySecondaryPanelComponents")
    .then((module) => module.preloadThreadSecondaryPanel())
    .catch(() => undefined);
}

export function useWindowTitleBarHostsRightPanelToggle(): boolean {
  return useIsSidebarFramed();
}

export function useWindowRightPanel({
  isOpen,
  enabled,
}: {
  isOpen: boolean;
  enabled: boolean;
}): void {
  const setRegistrations = useSetAtom(windowRightPanelRegistrationsAtom);
  useEffect(() => {
    if (!enabled) return;
    const token = Symbol("window-right-panel");
    setRegistrations((current) => [...current, { token, isOpen }]);

    return () => {
      setRegistrations((current) =>
        current.filter((registration) => registration.token !== token),
      );
    };
  }, [enabled, isOpen, setRegistrations]);
}

export function WindowRightPanelToggle({ className }: { className?: string }) {
  const panel = useAtomValue(windowRightPanelRegistrationsAtom).at(-1);
  const shortcut = useAppCommandShortcut("panel.toggle");
  const { dispatch } = useAppCommandRunner();

  if (panel === undefined) return null;
  const label = panel.isOpen ? "Hide right panel" : "Show right panel";

  return (
    <div className={cn("relative flex items-center", className)}>
      <AppCommandShortcutHint
        shortcut={shortcut}
        className="absolute right-full mr-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid="window-right-panel-toggle"
        {...appCommandTarget("panel.toggle")}
        className={cn(
          COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
          TITLE_BAR_SEGMENT_CLASS,
        )}
        aria-label={shortcut ? `${label} (${shortcut.label})` : label}
        aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        aria-expanded={panel.isOpen}
        onPointerEnter={preloadRightPanel}
        onFocus={preloadRightPanel}
        onPointerDown={preloadRightPanel}
        onClick={() => dispatch("panel.toggle", null)}
      >
        <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
      </Button>
    </div>
  );
}
