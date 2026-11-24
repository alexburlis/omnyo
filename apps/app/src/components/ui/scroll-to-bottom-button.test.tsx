// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_PAGE_HEADER_SURFACE_CLASS } from "@/components/layout/AppPageHeader";
import { AppToastContent } from "./app-toast";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";

const appSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  cleanup();
});

describe("surfaces that stay over the timeline do not blur their backdrop", () => {
  it("renders the scroll-to-bottom button on an opaque fill without blur", () => {
    const view = render(
      <ScrollToBottomButton visible active onClick={() => {}} />,
    );

    const button = view.getByRole("button", { name: "Jump to latest" });
    expect(button.textContent).toBe("Latest");
    expect(button.className).not.toContain("backdrop-blur");
    expect(button.className).toContain("bg-background");
    expect(button.className).not.toContain("hover:bg-state-hover");
    expect(button.className).toContain("hover:bg-accent");
    expect(button.className).not.toContain("invisible");
    expect(button.querySelector(".animate-shine-icon")).not.toBeNull();
  });

  it("stops the shimmer and hides the button while it is not shown", () => {
    const view = render(
      <ScrollToBottomButton visible={false} active onClick={() => {}} />,
    );

    const button = view.getByRole("button", {
      name: "Jump to latest",
      hidden: true,
    });

    expect(button.className).toContain("invisible");
    expect(button.querySelector(".animate-shine-icon")).toBeNull();
  });

  it("keeps the shared page-header surface free of blur", () => {
    expect(APP_PAGE_HEADER_SURFACE_CLASS).not.toContain("backdrop-blur");
  });

  it("keeps the shared overlay backdrops free of blur", () => {
    const sharedUiRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../packages/shared-ui",
    );

    for (const file of [
      "src/components/ui/dialog.tsx",
      "src/components/ui/drawer.tsx",
      "src/components/ui/responsive-overlay.tsx",
    ]) {
      const source = readFileSync(join(sharedUiRoot, file), "utf8");
      expect(source, file).not.toContain("backdrop-blur");
    }
  });

  it("keeps the shell material surfaces free of blur", () => {
    for (const file of [
      "app.css",
      "components/ui/theme.css",
      "components/layout/AppShellFrame.tsx",
      "components/layout/AppLayout.tsx",
      "components/layout/AppFooter.tsx",
      "components/ui/sidebar.tsx",
      "components/sidebar/AppNavRail.tsx",
      "components/sidebar/ProjectRail.tsx",
      "components/promptbox/PromptBoxInternal.tsx",
      "components/promptbox/banner/ThreadGoalCard.tsx",
      "components/notifications/NotificationCenter.tsx",
      "components/AppToasterView.tsx",
      "components/ui/app-toast.tsx",
    ]) {
      const source = readFileSync(join(appSourceRoot, file), "utf8");
      expect(source, file).not.toMatch(/backdrop-(?:blur|filter)/);
    }
  });

  it("renders toasts on the opaque popover material", () => {
    const view = render(<AppToastContent title="Saved" tone="success" />);

    const surface = view.container.querySelector("[data-app-toast-surface]");

    expect(surface?.className).toContain("bg-popover");
    expect(surface?.className).toContain("shadow-(--material-shadow-float)");
  });
});
