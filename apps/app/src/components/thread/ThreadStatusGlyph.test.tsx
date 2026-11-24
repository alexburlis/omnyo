// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSidebarThreadIndicator } from "@omnyo/plugin-sdk";
import { SIDEBAR_SUCCESS_STATUS_COLOR_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";

afterEach(() => {
  cleanup();
});

describe("ThreadStatusGlyph", () => {
  it.each([
    ["unread-error", "Failed", "CircleX"],
    ["queued-failed", "Queued message failed to send", "CircleX"],
    ["waiting-for-input", "Needs you", "CircleQuestion"],
    ["queued-waiting", "Thread has a message waiting to send", "CircleDashed"],
    ["callback-waiting", "Waiting", "CircleDashed"],
    ["working-draft", "Thread working with unsubmitted draft", null],
    ["workflow", "Workflow running", null],
    ["background-agent", "Background agent running", null],
    ["background-command", "Background command running", null],
    ["plan-mode", "Plan mode active", null],
    ["goal", "Goal active", null],
    ["runtime", "Working", null],
    ["open", "Done", "CircleCheck"],
    ["external", "External", "Sent"],
    ["ready-to-archive", "Ready to archive", "CircleCheckSolid"],
    ["draft", "Thread has unsubmitted draft", "Edit"],
  ] satisfies [PluginSidebarThreadIndicator, string, string | null][])(
    "draws %s as a labelled %s glyph",
    (indicator, label, icon) => {
      render(<ThreadStatusGlyph indicator={indicator} />);

      const glyph = screen.getByLabelText(label);
      expect(glyph.getAttribute("data-icon")).toBe(icon);

      if (icon === null) {
        expect(glyph.querySelector(".omnyo-working-orb-ring")).not.toBeNull();
        expect(glyph.classList.contains("size-4")).toBe(true);
      }
    },
  );

  it("draws unread success as a dot and nothing for none", () => {
    const { container, rerender } = render(
      <ThreadStatusGlyph indicator="unread-success" />,
    );

    expect(screen.getByLabelText("Unread thread succeeded").tagName).toBe(
      "SPAN",
    );

    rerender(<ThreadStatusGlyph indicator="none" />);
    expect(container.firstChild).toBeNull();
  });

  it("hides the idle draft glyph from assistive technology on request", () => {
    const { container } = render(
      <ThreadStatusGlyph indicator="draft" hideIdleDraftLabel />,
    );

    const draft = container.querySelector('[data-icon="Edit"]');
    expect(draft?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
  });

  it("draws the archive glyph for archived threads", () => {
    render(<ThreadStatusGlyph indicator="runtime" archived />);

    expect(
      screen.getByLabelText("Archived thread").getAttribute("data-icon"),
    ).toBe("Archive");
  });

  it.each([
    ["running", "inline-flex"],
    ["success", SIDEBAR_SUCCESS_STATUS_COLOR_CLASS],
    ["error", "text-destructive"],
  ] as const)("draws a %s row status with its tone", (tone, className) => {
    render(
      <ThreadStatusGlyph
        indicator="draft"
        rowStatus={{ icon: "AiContentGenerator01", label: "Improving", tone }}
      />,
    );

    const status = screen.getByLabelText("Improving");
    expect(status.getAttribute("data-icon")).toBe(
      tone === "running" ? null : "AiContentGenerator01",
    );
    expect(Array.from(status.classList)).toContain(className);
    expect(status.querySelector(".omnyo-working-orb") !== null).toBe(
      tone === "running",
    );
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
  });

  it.each([
    [1, "Working · 1 subagent"],
    [3, "Working · 3 subagents"],
    [12, "Working · 12 subagents"],
  ] as const)(
    "draws a subagent count of %i inside the working spinner",
    (count, label) => {
      render(
        <ThreadStatusGlyph
          indicator="runtime"
          experimental_subagents={count}
        />,
      );

      const glyph = screen.getByRole("img", { name: label });
      expect(glyph.textContent).toBe(String(count));
      expect(glyph.classList.contains("text-timeline-accent")).toBe(true);
      expect(glyph.querySelector(".animate-spin")).not.toBeNull();
      expect(screen.queryByLabelText("Working")).toBeNull();
    },
  );

  it("labels a running row status with its subagent count", () => {
    render(
      <ThreadStatusGlyph
        indicator="draft"
        rowStatus={{
          icon: "AiContentGenerator01",
          label: "Improving",
          tone: "running",
        }}
        experimental_subagents={2}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Improving · 2 subagents" }).textContent,
    ).toBe("2");
  });

  it.each([
    ["runtime", 0, "Working"],
    ["waiting-for-input", 3, "Needs you"],
    ["ready-to-archive", 3, "Ready to archive"],
  ] satisfies [PluginSidebarThreadIndicator, number, string][])(
    "leaves the %s glyph unchanged with %i subagents",
    (indicator, count, label) => {
      const { container: withCount } = render(
        <ThreadStatusGlyph
          indicator={indicator}
          experimental_subagents={count}
        />,
      );

      const { container: plain } = render(
        <ThreadStatusGlyph indicator={indicator} />,
      );

      expect(withCount.innerHTML).toBe(plain.innerHTML);
      expect(screen.getAllByLabelText(label)).toHaveLength(2);
      expect(withCount.textContent).toBe("");
    },
  );

  it.each([
    ["runtime", "Working"],
    ["unread-error", "Failed"],
    ["waiting-for-input", "Needs you"],
  ] satisfies [PluginSidebarThreadIndicator, string][])(
    "keeps %s ahead of a row status",
    (indicator, label) => {
      render(
        <ThreadStatusGlyph
          indicator={indicator}
          rowStatus={{ icon: "AiContentGenerator01", label: "Improving" }}
        />,
      );

      expect(screen.getByLabelText(label)).not.toBeNull();
      expect(screen.queryByLabelText("Improving")).toBeNull();
    },
  );
});
