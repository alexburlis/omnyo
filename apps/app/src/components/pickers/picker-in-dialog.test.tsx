// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { PermissionModePicker } from "./PermissionModePicker";
import { ProjectSelector } from "./ProjectSelector";

const PROJECTS = [
  { id: "proj_alpha", name: "Alpha Web" },
  { id: "proj_bravo", name: "Bravo API" },
] as const;

const PERMISSION_OPTIONS = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SharedUiDialog({ children }: { children: ReactNode }) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Launcher</DialogTitle>
        <DialogDescription>Start a chat</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function PluginBundledDialog({ children }: { children: ReactNode }) {
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay />
        <DialogPrimitive.Content aria-describedby={undefined}>
          <DialogPrimitive.Title>Plugin dialog</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const DIALOGS = [
  ["the shared-ui dialog", SharedUiDialog],
  ["a plugin's own Radix dialog", PluginBundledDialog],
] as const;

function makeScrollable(element: HTMLElement): void {
  element.style.overflowY = "auto";
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 100,
  });
}

function touchList(clientX: number, clientY: number): TouchList {
  const touch = { identifier: 1, clientX, clientY } as Touch;
  const list = { length: 1, item: () => touch, 0: touch };

  return list as unknown as TouchList;
}

function fireTouch(
  target: Element,
  type: "touchstart" | "touchmove",
  clientY: number,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touchList(20, clientY) },
    changedTouches: { value: touchList(20, clientY) },
  });
  fireEvent(target, event);

  return event;
}

function expectListScrolls(item: Element): void {
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 40,
  });

  fireEvent(item, wheel);
  expect(wheel.defaultPrevented).toBe(false);

  fireTouch(item, "touchstart", 200);
  const move = fireTouch(item, "touchmove", 160);
  expect(move.defaultPrevented).toBe(false);
}

describe.each(DIALOGS)("pickers opened inside %s", (_label, DialogHost) => {
  it("keeps the project list scrollable by wheel and touch", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <DialogHost>
          <ProjectSelector
            projects={PROJECTS}
            value={null}
            onChange={vi.fn()}
          />
        </DialogHost>
      </CompactViewportOverrideProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Project/ }));
    const item = screen.getByRole("option", { name: "Bravo API" });
    const list = item.parentElement;

    if (list === null) throw new Error("Expected the project list");
    makeScrollable(list);

    expectListScrolls(item);
  });

  it("keeps the permission menu scrollable by wheel and touch", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <DialogHost>
          <PermissionModePicker
            value="auto"
            options={PERMISSION_OPTIONS}
            onChange={vi.fn()}
            supported
          />
        </DialogHost>
      </CompactViewportOverrideProvider>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Permission mode" }), {
      key: "Enter",
    });
    makeScrollable(screen.getByRole("menu"));

    expectListScrolls(screen.getByRole("menuitem", { name: /Accept/ }));
  });
});
