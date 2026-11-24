// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { PermissionModePicker } from "./PermissionModePicker";
import { expectNonmodalPicker } from "@/test/nonmodal-picker";

const permissionOptions = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
] as const;

function renderOnDesktop(ui: ReactNode) {
  return render(
    <CompactViewportOverrideProvider isCompactViewport={false}>
      {ui}
    </CompactViewportOverrideProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PermissionModePicker", () => {
  it("keeps the page interactive and closes when focus leaves", async () => {
    renderOnDesktop(
      <PermissionModePicker
        value="auto"
        options={permissionOptions}
        onChange={vi.fn()}
        supported
      />,
    );
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    await expectNonmodalPicker({
      trigger,
      open: () => fireEvent.keyDown(trigger, { key: "Enter" }),
      content: () => screen.queryByRole("menu"),
    });
  });

  it("keeps the warning mode caret aligned with the other prompt box carets", () => {
    const { container } = render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
        onChange={vi.fn()}
        supported
      />,
    );

    const caret = container.querySelector('[data-icon="ChevronDown"]');
    expect(caret).not.toBeNull();
    expect(caret!.classList).toContain("text-subtle-foreground/75");
    expect(caret!.classList).not.toContain("text-warning-text");
  });

  it("can show an effective display override without changing the selected value", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
        onChange={onChange}
        supported
        displayOverride={{
          label: "Plan Mode",
          compactLabel: "Plan",
          description:
            "Claude Code will plan without normal full-access execution.",
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Plan Mode");
    expect(trigger.textContent).not.toContain("Full Access");
  });

  describe("icon presentation", () => {
    it.each([
      {
        value: "accept-edits",
        name: "Approvals: Accept Edits",
        icon: "ShieldUser",
      },
      {
        value: "auto",
        name: "Approvals: Approve for me",
        icon: "ShieldCheck",
      },
      { value: "full", name: "Approvals: Full Access", icon: "ShieldOff" },
    ] as const)(
      "names the $value mode with one icon",
      ({ value, name, icon }) => {
        renderOnDesktop(
          <PermissionModePicker
            value={value}
            options={permissionOptions}
            onChange={vi.fn()}
            supported
            presentation="icon"
          />,
        );

        const trigger = screen.getByRole("button", { name });
        expect(trigger.textContent).toBe("");
        expect(trigger.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
      },
    );

    it("explains the selected mode with its description on hover", () => {
      renderOnDesktop(
        <PermissionModePicker
          value="auto"
          options={[
            {
              value: "accept-edits",
              label: "Accept Edits",
              description: "Asks before leaving the workspace.",
            },
            {
              value: "auto",
              label: "Approve for me",
              description: "Reviews requests automatically.",
            },
          ]}
          onChange={vi.fn()}
          supported
          presentation="icon"
        />,
      );

      const trigger = screen.getByRole("button", {
        name: "Approvals: Approve for me",
      });

      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
        "Approvals: Approve for me - Reviews requests automatically.",
      );
    });

    it("opens every approval mode and selects the chosen one", async () => {
      const onChange = vi.fn();
      renderOnDesktop(
        <PermissionModePicker
          value="accept-edits"
          options={permissionOptions}
          onChange={onChange}
          supported
          presentation="icon"
        />,
      );

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Approvals: Accept Edits" }),
        { button: 0 },
      );

      const items = await screen.findAllByRole("menuitem");
      expect(screen.getByText("Approvals")).toBeTruthy();
      expect(items.map((item) => item.textContent)).toEqual([
        "Accept Edits",
        "Approve for me",
        "Full Access",
      ]);

      fireEvent.click(screen.getByRole("menuitem", { name: "Full Access" }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith("full");
    });

    it("shows plan mode on a disabled trigger that opens no menu", () => {
      renderOnDesktop(
        <PermissionModePicker
          value="full"
          options={permissionOptions}
          onChange={vi.fn()}
          supported
          disabled
          presentation="icon"
          displayOverride={{
            label: "Plan Mode",
            compactLabel: "Plan",
            description: "Claude Code will plan before it edits.",
          }}
        />,
      );

      const trigger = screen.getByRole("button", {
        name: "Approvals: Plan Mode",
      });

      expect(trigger.hasAttribute("disabled")).toBe(true);
      expect(trigger.querySelector('[data-icon="ListTodo"]')).not.toBeNull();
      expect(trigger.querySelector('[data-icon="ShieldOff"]')).toBeNull();
      fireEvent.pointerDown(trigger, { button: 0 });
      expect(screen.queryByRole("menuitem")).toBeNull();
    });
  });
});
