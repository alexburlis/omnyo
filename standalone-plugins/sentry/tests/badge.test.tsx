import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SentryRailBadge } from "../src/ui/badge";

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-nav-rail-item]").forEach((element) => element.remove());
});

function rail() {
  const target = document.createElement("span");
  target.dataset.navRailItem = "sentry/sentry";
  target.className = "foreign-class";
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Sentry (shortcut)");
  target.append(button);
  document.body.append(target);

  return target;
}

describe("global Sentry icon count", () => {
  it("attaches to the actual navigation rail, updates counts and follows rail replacement without touching the button", async () => {
    const first = rail();
    const view = render(<SentryRailBadge count={201} freshness="live" />);
    await waitFor(() => expect(first.querySelector(".sentry-rail-badge")?.textContent).toBe("99+"));
    expect(first.querySelector(".sentry-rail-badge")?.getAttribute("title")).toContain(
      "201 open Sentry issues",
    );

    const second = await act(async () => {
      first.remove();

      return rail();
    });

    view.rerender(<SentryRailBadge count={4} freshness="stale" />);
    await waitFor(() => expect(second.querySelector(".sentry-rail-badge")?.textContent).toBe("4"));
    expect(second.querySelector(".sentry-rail-badge")?.getAttribute("title")).toContain(
      "Last known",
    );
    expect(second.querySelector("button")?.getAttribute("aria-label")).toBe("Sentry (shortcut)");
    view.unmount();
    expect(second.className).toBe("foreign-class");
    expect(second.querySelector(".sentry-rail-badge")).toBeNull();
  });

  it("does not display a zero count for unconfigured monitoring", () => {
    const target = rail();
    render(<SentryRailBadge count={0} freshness="unconfigured" />);
    expect(target.querySelector(".sentry-rail-badge")).toBeNull();
  });
});
