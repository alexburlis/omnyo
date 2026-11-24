import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  findAppKeybindingOverride,
  isMacKeyboardPlatform,
  keyboardPlatform,
  type AppShortcut,
  type KeyboardCommandId,
} from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import {
  useAppShortcutEditor,
  type AppShortcutCommandMetadata,
} from "@/hooks/useAppShortcutEditor";
import { appShortcutKeycaps, formatAppShortcut } from "@/lib/app-keybindings";
import {
  APP_COMMAND_INLINE_HINT_ATTRIBUTE,
  APP_COMMAND_TARGET_SELECTOR,
  readAppCommandTarget,
} from "@/lib/app-command-targets";
import {
  getCommandShortcut,
  isAppCommandAvailableForClient,
  readRecordedShortcut,
} from "@/lib/keyboard-shortcut-settings";
import {
  useIsAppCommandModifierHeld,
  useSuspendAppShortcuts,
} from "./AppCommandProvider";

const OVERLAY_ATTRIBUTE = "data-app-shortcut-overlay";

const OVERLAY_SELECTOR = `[${OVERLAY_ATTRIBUTE}]`;

const SHEET_COLLAPSED_STORAGE_KEY = "omnyo.shortcutOverlay.sheetCollapsed";

const TARGET_RESCAN_INTERVAL_MS = 250;

const EDITOR_WIDTH_PX = 304;

const EDITOR_GAP_PX = 8;

const VIEWPORT_MARGIN_PX = 8;

const SWALLOWED_GESTURE_WINDOW_MS = 1000;

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "OS", "Shift"]);

const SWALLOWED_GESTURE_EVENTS = [
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

interface ShortcutTarget {
  command: KeyboardCommandId;
  id: number;
  rect: DOMRect;
}

interface EditingState {
  anchor: DOMRect;
  command: KeyboardCommandId;
  restoreFocus: HTMLElement | null;
  source: "element" | "sheet";
}

interface LiveModifiers {
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
}

const NO_MODIFIERS: LiveModifiers = {
  alt: false,
  control: false,
  meta: false,
  shift: false,
};

function readSheetCollapsed(): boolean {
  try {
    return localStorage.getItem(SHEET_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSheetCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SHEET_COLLAPSED_STORAGE_KEY, "1");
    else localStorage.removeItem(SHEET_COLLAPSED_STORAGE_KEY);
  } catch {}
}

function isTargetShown(element: HTMLElement, rect: DOMRect): boolean {
  if (rect.width < 2 || rect.height < 2) return false;

  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  ) {
    return false;
  }

  if (element.closest("[inert]") !== null) return false;

  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
    })
  ) {
    return false;
  }

  const x = Math.min(
    Math.max(rect.left + rect.width / 2, 0),
    window.innerWidth - 1,
  );

  const y = Math.min(
    Math.max(rect.top + rect.height / 2, 0),
    window.innerHeight - 1,
  );

  const hit = document.elementFromPoint(x, y);

  if (hit === null) return false;

  return element === hit || element.contains(hit) || hit.contains(element);
}

function collectShortcutTargets(
  hasShortcut: (command: KeyboardCommandId) => boolean,
): ShortcutTarget[] {
  const targets: ShortcutTarget[] = [];
  let id = 0;

  for (const element of document.querySelectorAll<HTMLElement>(
    APP_COMMAND_TARGET_SELECTOR,
  )) {
    if (element.closest(OVERLAY_SELECTOR) !== null) continue;
    const command = readAppCommandTarget(element);

    if (command === null || !hasShortcut(command)) continue;

    if (element.querySelector(`[${APP_COMMAND_INLINE_HINT_ATTRIBUTE}]`)) {
      continue;
    }

    const rect = element.getBoundingClientRect();

    if (!isTargetShown(element, rect)) continue;
    id += 1;
    targets.push({ command, id, rect });
  }

  return targets;
}

function sameTargets(
  left: readonly ShortcutTarget[],
  right: readonly ShortcutTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const other = right[index];

      return (
        other !== undefined &&
        other.command === target.command &&
        Math.round(other.rect.left) === Math.round(target.rect.left) &&
        Math.round(other.rect.top) === Math.round(target.rect.top) &&
        Math.round(other.rect.width) === Math.round(target.rect.width) &&
        Math.round(other.rect.height) === Math.round(target.rect.height)
      );
    })
  );
}

function Keycaps({
  keys,
  size = "sm",
  className,
}: {
  keys: readonly string[];
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={cn(
            "inline-flex items-center justify-center rounded-[5px] border border-border bg-surface-raised-solid font-sans leading-none tabular-nums text-foreground shadow-[0_1px_0_var(--border)]",
            size === "sm"
              ? "h-[18px] min-w-[18px] px-1 text-[11px] font-medium"
              : "h-7 min-w-7 px-1.5 text-sm font-medium",
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function liveModifierKeycaps(
  modifiers: LiveModifiers,
  platform: string,
): string[] {
  const mac = isMacKeyboardPlatform(platform);
  const keys: string[] = [];

  if (modifiers.control) keys.push(mac ? "⌃" : "Ctrl");

  if (modifiers.alt) keys.push(mac ? "⌥" : "Alt");

  if (modifiers.shift) keys.push(mac ? "⇧" : "Shift");

  if (modifiers.meta) keys.push(mac ? "⌘" : "Meta");

  return keys;
}

function readLiveModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): LiveModifiers {
  return {
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

export function AppCommandShortcutOverlay() {
  const held = useIsAppCommandModifierHeld();
  const suspendShortcuts = useSuspendAppShortcuts();
  const editor = useAppShortcutEditor();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [targets, setTargets] = useState<readonly ShortcutTarget[]>([]);
  const [sheetCollapsed, setSheetCollapsed] = useState(readSheetCollapsed);
  const [sheetDismissed, setSheetDismissed] = useState(false);

  const [hoveredCommand, setHoveredCommand] =
    useState<KeyboardCommandId | null>(null);

  const active = held || editing !== null;
  const swallowGestureUntilRef = useRef(0);

  const { defaults, isDesktop, overrides, platform, setPendingAssignment } =
    editor;

  const metadata = useMemo(
    () =>
      new Map<KeyboardCommandId, AppShortcutCommandMetadata>(
        editor.commandGroups.flatMap((group) =>
          group.commands.map((entry) => [entry.command, entry] as const),
        ),
      ),
    [editor.commandGroups],
  );

  const shortcutFor = useCallback(
    (command: KeyboardCommandId): AppShortcut | null =>
      getCommandShortcut(defaults, overrides, command, isDesktop, platform),
    [defaults, isDesktop, overrides, platform],
  );

  const isEditable = useCallback(
    (command: KeyboardCommandId): boolean =>
      metadata.has(command) &&
      isAppCommandAvailableForClient(defaults, command, isDesktop, platform),
    [defaults, isDesktop, metadata, platform],
  );

  const latestRef = useRef({ held, editing, isEditable, shortcutFor });
  useLayoutEffect(() => {
    latestRef.current = { held, editing, isEditable, shortcutFor };
  }, [editing, held, isEditable, shortcutFor]);

  useEffect(() => {
    if (!held) setSheetDismissed(false);
  }, [held]);

  useEffect(() => {
    if (!active) {
      setTargets([]);

      return;
    }

    let frame = 0;

    const scan = () => {
      frame = 0;

      const next = collectShortcutTargets(
        (command) => latestRef.current.shortcutFor(command) !== null,
      );

      setTargets((previous) => (sameTargets(previous, next) ? previous : next));
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(scan);
    };

    scan();
    const interval = window.setInterval(schedule, TARGET_RESCAN_INTERVAL_MS);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [active, overrides]);

  const openEditor = useCallback(
    (
      command: KeyboardCommandId,
      anchor: DOMRect,
      source: EditingState["source"],
    ) => {
      setPendingAssignment(null);
      setEditing((previous) => ({
        anchor,
        command,
        restoreFocus:
          previous?.restoreFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null),
        source,
      }));
    },
    [setPendingAssignment],
  );

  const closeEditor = useCallback(() => {
    const restore = latestRef.current.editing?.restoreFocus;
    setPendingAssignment(null);
    setEditing(null);

    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, [setPendingAssignment]);

  useEffect(() => {
    if (!active) return;

    const handlePointerDown = (event: PointerEvent) => {
      swallowGestureUntilRef.current = 0;
      const target = event.target instanceof Element ? event.target : null;

      if (target?.closest(OVERLAY_SELECTOR)) return;

      const element = target?.closest<HTMLElement>(APP_COMMAND_TARGET_SELECTOR);
      const command = element ? readAppCommandTarget(element) : null;
      const modifierPressed = event.metaKey || event.ctrlKey;

      if (
        element &&
        command !== null &&
        event.button === 0 &&
        modifierPressed &&
        latestRef.current.isEditable(command)
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        swallowGestureUntilRef.current =
          Date.now() + SWALLOWED_GESTURE_WINDOW_MS;
        openEditor(command, element.getBoundingClientRect(), "element");

        return;
      }

      if (latestRef.current.editing !== null) closeEditor();
    };

    const swallow = (event: Event) => {
      if (Date.now() >= swallowGestureUntilRef.current) return;

      if (
        event.target instanceof Element &&
        event.target.closest(OVERLAY_SELECTOR) !== null
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.type === "click" || event.type === "contextmenu") {
        swallowGestureUntilRef.current = 0;
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);

    for (const type of SWALLOWED_GESTURE_EVENTS) {
      window.addEventListener(type, swallow, true);
    }

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);

      for (const type of SWALLOWED_GESTURE_EVENTS) {
        window.removeEventListener(type, swallow, true);
      }
    };
  }, [active, closeEditor, openEditor]);

  useEffect(() => {
    if (!held || editing !== null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(event.key)) setSheetDismissed(true);
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editing, held]);

  useEffect(() => {
    if (!active) {
      setHoveredCommand(null);

      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const element = target?.closest(APP_COMMAND_TARGET_SELECTOR);
      const command = element ? readAppCommandTarget(element) : null;
      setHoveredCommand(
        command !== null && latestRef.current.isEditable(command)
          ? command
          : null,
      );
    };

    window.addEventListener("pointermove", handlePointerMove, true);

    return () =>
      window.removeEventListener("pointermove", handlePointerMove, true);
  }, [active]);

  if (!active && targets.length === 0) return null;

  const showSheet =
    active &&
    !sheetDismissed &&
    (editing === null || editing.source === "sheet");

  return createPortal(
    <div {...{ [OVERLAY_ATTRIBUTE]: "" }}>
      <ShortcutBadges
        editingCommand={editing?.command ?? null}
        hoveredCommand={hoveredCommand}
        platform={platform}
        shortcutFor={shortcutFor}
        targets={active ? targets : []}
      />
      {showSheet ? (
        <ShortcutSheet
          collapsed={sheetCollapsed}
          editingCommand={editing?.command ?? null}
          editor={editor}
          isEditable={isEditable}
          onCollapsedChange={(collapsed) => {
            writeSheetCollapsed(collapsed);
            setSheetCollapsed(collapsed);
          }}
          onEdit={(command, anchor) => openEditor(command, anchor, "sheet")}
          shortcutFor={shortcutFor}
        />
      ) : null}
      {editing !== null ? (
        <ShortcutEditorPopover
          editing={editing}
          editor={editor}
          label={metadata.get(editing.command)?.label ?? editing.command}
          onClose={closeEditor}
          shortcut={shortcutFor(editing.command)}
          suspendShortcuts={suspendShortcuts}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function ShortcutBadges({
  editingCommand,
  hoveredCommand,
  platform,
  shortcutFor,
  targets,
}: {
  editingCommand: KeyboardCommandId | null;
  hoveredCommand: KeyboardCommandId | null;
  platform: string;
  shortcutFor: (command: KeyboardCommandId) => AppShortcut | null;
  targets: readonly ShortcutTarget[];
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-90"
      data-testid="app-shortcut-badges"
    >
      {targets.map((target) => {
        const shortcut = shortcutFor(target.command);

        if (shortcut === null) return null;

        const emphasized =
          target.command === hoveredCommand ||
          target.command === editingCommand;

        const placeAbove = target.rect.bottom + 24 > window.innerHeight;

        const style: CSSProperties = {
          left: Math.min(
            Math.max(target.rect.left + target.rect.width / 2, 24),
            window.innerWidth - 24,
          ),
          top: placeAbove ? target.rect.top - 4 : target.rect.bottom - 6,
        };

        return (
          <div key={target.id}>
            {emphasized ? (
              <div
                className="absolute rounded-md ring-2 ring-ring/70"
                style={{
                  height: target.rect.height + 4,
                  left: target.rect.left - 2,
                  top: target.rect.top - 2,
                  width: target.rect.width + 4,
                }}
              />
            ) : null}
            <div
              className={cn(
                "absolute -translate-x-1/2 rounded-md bg-popover/95 p-0.5 shadow-md ring-1 ring-border backdrop-blur-sm animate-in fade-in-0 zoom-in-95 duration-(--motion-duration-fast)",
                placeAbove && "-translate-y-full",
                emphasized && "ring-ring",
              )}
              data-app-shortcut-badge={target.command}
              style={style}
            >
              <Keycaps keys={appShortcutKeycaps(shortcut, platform)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ShortcutSheet({
  collapsed,
  editingCommand,
  editor,
  isEditable,
  onCollapsedChange,
  onEdit,
  shortcutFor,
}: {
  collapsed: boolean;
  editingCommand: KeyboardCommandId | null;
  editor: ReturnType<typeof useAppShortcutEditor>;
  isEditable: (command: KeyboardCommandId) => boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onEdit: (command: KeyboardCommandId, anchor: DOMRect) => void;
  shortcutFor: (command: KeyboardCommandId) => AppShortcut | null;
}) {
  const { platform } = editor;
  const modifierGlyph = isMacKeyboardPlatform(platform) ? "⌘" : "Ctrl";

  const groups = useMemo(
    () =>
      editor.commandGroups
        .map((group) => ({
          label: group.label,
          rows: group.commands.flatMap((entry) => {
            const shortcut = shortcutFor(entry.command);

            return shortcut === null || !isEditable(entry.command)
              ? []
              : [{ ...entry, shortcut }];
          }),
        }))
        .filter((group) => group.rows.length > 0),
    [editor.commandGroups, isEditable, shortcutFor],
  );

  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (collapsed) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-90 flex justify-center">
        <button
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-popover/95 py-1.5 pr-3 pl-2 text-xs text-foreground shadow-lg ring-1 ring-border backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-2 duration-(--motion-duration-base)"
          onClick={() => onCollapsedChange(false)}
          type="button"
        >
          <Icon className="size-3.5 text-subtle-foreground" name="Keyboard" />
          Show all {total} shortcuts
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-90 flex items-center justify-center p-6">
      <section
        aria-label="Keyboard shortcuts"
        className="pointer-events-auto flex max-h-[min(36rem,calc(100vh-6rem))] w-[min(52rem,100%)] flex-col overflow-hidden rounded-xl bg-popover/90 text-popover-foreground shadow-xl ring-1 ring-border backdrop-blur-xl animate-in fade-in-0 zoom-in-[0.98] duration-(--motion-duration-base)"
        data-testid="app-shortcut-sheet"
      >
        <header className="flex items-center gap-3 border-b border-border-seam px-4 py-3">
          <div className="flex size-7 items-center justify-center rounded-md bg-surface-recessed">
            <Icon className="size-4 text-foreground" name="Keyboard" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-foreground">
              Keyboard shortcuts
            </h2>
            <p className="text-xs text-subtle-foreground">
              Keep holding {modifierGlyph} and click any shortcut, or any badged
              button, to change it.
            </p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
            {total === 1 ? "1 shortcut" : `${total} shortcuts`}
          </span>
          <Button
            aria-label="Hide shortcut list"
            className="size-7"
            onClick={() => onCollapsedChange(true)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon className="size-3.5" name="ChevronDown" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="columns-[15rem] gap-6">
            {groups.map((group) => (
              <section className="mb-4 break-inside-avoid" key={group.label}>
                <h3 className="mb-1 px-1.5 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                  {group.label}
                </h3>
                <ul>
                  {group.rows.map((row) => (
                    <li key={row.command}>
                      <button
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left text-xs text-foreground hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
                          editingCommand === row.command &&
                            "bg-surface-selected hover:bg-surface-selected",
                        )}
                        data-app-shortcut-row={row.command}
                        onClick={(event) =>
                          onEdit(
                            row.command,
                            event.currentTarget.getBoundingClientRect(),
                          )
                        }
                        title={row.description}
                        type="button"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {row.label}
                        </span>
                        <Keycaps
                          keys={appShortcutKeycaps(row.shortcut, platform)}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function editorPosition(anchor: DOMRect): CSSProperties {
  const left = Math.min(
    Math.max(
      anchor.left + anchor.width / 2 - EDITOR_WIDTH_PX / 2,
      VIEWPORT_MARGIN_PX,
    ),
    window.innerWidth - EDITOR_WIDTH_PX - VIEWPORT_MARGIN_PX,
  );

  const spaceBelow = window.innerHeight - anchor.bottom;

  return spaceBelow >= 240 || spaceBelow >= anchor.top
    ? { left, top: anchor.bottom + EDITOR_GAP_PX, width: EDITOR_WIDTH_PX }
    : {
        bottom: window.innerHeight - anchor.top + EDITOR_GAP_PX,
        left,
        width: EDITOR_WIDTH_PX,
      };
}

function ShortcutEditorPopover({
  editing,
  editor,
  label,
  onClose,
  shortcut,
  suspendShortcuts,
}: {
  editing: EditingState;
  editor: ReturnType<typeof useAppShortcutEditor>;
  label: string;
  onClose: () => void;
  shortcut: AppShortcut | null;
  suspendShortcuts: () => () => void;
}) {
  const { command } = editing;

  const {
    assignCommand,
    pendingAssignment,
    platform,
    resetCommands,
    setPendingAssignment,
  } = editor;

  const panelRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveModifiers, setLiveModifiers] = useState(NO_MODIFIERS);

  const conflict =
    pendingAssignment !== null && pendingAssignment.command === command
      ? pendingAssignment
      : null;

  const defaultShortcut = getCommandShortcut(
    editor.defaults,
    [],
    command,
    editor.isDesktop,
    platform,
  );

  const customized =
    findAppKeybindingOverride(
      editor.overrides,
      command,
      keyboardPlatform(platform),
    ) !== undefined;

  const finish = useCallback(
    (next: AppShortcut | null) => {
      appToast.success(
        next === null
          ? `Removed the shortcut for ${label}`
          : `${label} is now ${formatAppShortcut(next, platform)}`,
      );
      onClose();
    },
    [label, onClose, platform],
  );

  const assign = useCallback(
    (next: AppShortcut | null, replace: boolean) => {
      if (assignCommand(command, next, replace) === "applied") finish(next);
    },
    [assignCommand, command, finish],
  );

  const latestRef = useRef({ assign, conflict, onClose });
  useLayoutEffect(() => {
    latestRef.current = { assign, conflict, onClose };
  }, [assign, conflict, onClose]);

  useEffect(() => {
    setError(null);
    panelRef.current?.focus({ preventScroll: true });
  }, [command]);

  useEffect(() => {
    const release = suspendShortcuts();

    const handleKeyDown = (event: KeyboardEvent) => {
      const focusInPanel =
        panelRef.current?.contains(document.activeElement) === true &&
        document.activeElement !== panelRef.current;

      const plain =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

      if (
        event.key === "Tab" ||
        (focusInPanel && plain && (event.key === "Enter" || event.key === " "))
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.repeat) return;

      if (MODIFIER_KEYS.has(event.key)) {
        setLiveModifiers(readLiveModifiers(event));

        return;
      }

      const current = latestRef.current;

      if (current.conflict !== null) {
        if (event.key === "Escape") {
          setPendingAssignment(null);

          return;
        }

        if (event.key === "Enter") {
          current.assign(current.conflict.shortcut, true);

          return;
        }
      }

      const recorded = readRecordedShortcut(event, command, platform);

      if (recorded.kind === "cancel") {
        current.onClose();

        return;
      }

      if (recorded.kind === "error") {
        setError(recorded.message);

        return;
      }

      setError(null);
      current.assign(recorded.shortcut, false);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      setLiveModifiers(readLiveModifiers(event));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    return () => {
      release();
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [command, platform, setPendingAssignment, suspendShortcuts]);

  const liveKeys = liveModifierKeycaps(liveModifiers, platform);

  return (
    <div
      aria-label={`Change the shortcut for ${label}`}
      className="fixed z-95 rounded-xl bg-popover/95 p-3 text-popover-foreground shadow-xl ring-1 ring-border backdrop-blur-xl outline-none animate-in fade-in-0 zoom-in-95 duration-(--motion-duration-base)"
      data-testid="app-shortcut-editor"
      ref={panelRef}
      role="dialog"
      style={editorPosition(editing.anchor)}
      tabIndex={-1}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {label}
          </p>
          <p className="text-xs text-subtle-foreground">
            {conflict === null
              ? "Press the new shortcut · Esc to cancel"
              : "That shortcut is taken"}
          </p>
        </div>
        <Button
          aria-label="Close shortcut editor"
          className="-mt-1 -mr-1 size-6"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Icon className="size-3.5" name="X" />
        </Button>
      </div>
      <div
        aria-live="polite"
        className={cn(
          "mt-3 flex h-14 items-center justify-center gap-2 rounded-lg border border-dashed",
          conflict === null
            ? "border-ring/60 bg-surface-selected"
            : "border-warning/60 bg-surface-attention",
        )}
      >
        {conflict !== null ? (
          <Keycaps
            keys={appShortcutKeycaps(conflict.shortcut, platform)}
            size="lg"
          />
        ) : liveKeys.length > 0 ? (
          <>
            <Keycaps keys={liveKeys} size="lg" />
            <span className="animate-pulse text-sm text-subtle-foreground motion-reduce:animate-none">
              …
            </span>
          </>
        ) : shortcut !== null ? (
          <Keycaps
            className="opacity-50"
            keys={appShortcutKeycaps(shortcut, platform)}
            size="lg"
          />
        ) : (
          <span className="text-sm text-subtle-foreground">
            Type a shortcut
          </span>
        )}
      </div>
      {error !== null ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {conflict !== null ? (
        <div className="mt-3 space-y-2" role="alert">
          <p className="text-xs text-foreground">
            Already used by{" "}
            {conflict.conflicts
              .map((id) => editor.labels.get(id) ?? id)
              .join(", ")}
            . Replace it?
          </p>
          <div className="flex justify-end gap-1.5">
            <Button
              onClick={() => editor.setPendingAssignment(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Try another
            </Button>
            <Button
              disabled={editor.disabled}
              onClick={() => assign(conflict.shortcut, true)}
              size="sm"
              type="button"
            >
              Replace
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1">
          {defaultShortcut !== null ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-subtle-foreground">
              Default
              <Keycaps keys={appShortcutKeycaps(defaultShortcut, platform)} />
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {customized ? (
            <Button
              disabled={editor.disabled}
              onClick={() => {
                resetCommands([command]);
                finish(defaultShortcut);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Icon className="size-3.5" name="RotateCcw" />
              Reset
            </Button>
          ) : null}
          {shortcut !== null ? (
            <Button
              disabled={editor.disabled}
              onClick={() => assign(null, false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
