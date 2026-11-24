// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  isThreadDisplayStatusBannerActive,
  ThreadPromptContextBanner,
} from "./ThreadPromptContextBanner";

const noop = () => {};

afterEach(cleanup);

describe("ThreadPromptContextBanner", () => {
  it("renders the archived read-only status without an action", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        archivedSection={{ archivedAt: 1_731_456_000_000 }}
        environmentGoneSection={null}
        parentThreadSection={null}
        continuedInSection={null}
        childThreadsSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Thread is archived");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<button");
  });

  it.each([
    ["removed", "Machine removed"],
    ["removing", "Machine removal in progress"],
    ["cleanup-failed", "Machine cleanup failed"],
    ["destroyed", "Environment unavailable"],
  ] as const)(
    "collapses the %s explanation behind its status toggle by default",
    (status, label) => {
      const toggled: string[] = [];
      render(
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={{ status }}
          parentThreadSection={null}
          continuedInSection={null}
          childThreadsSection={null}
          expandedSection={null}
          onToggleSection={(section) => toggled.push(section)}
        />,
      );
      const toggle = screen.getByRole("button", { name: label });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText(/history|machine settings/)).toBeNull();
      expect(screen.queryByText("Provision")).toBeNull();
      toggle.click();
      expect(toggled).toEqual(["status"]);
    },
  );

  it("shows the machine removal explanation once the status is expanded", () => {
    render(
      <ThreadPromptContextBanner
        archivedSection={null}
        environmentGoneSection={{ status: "cleanup-failed" }}
        parentThreadSection={null}
        continuedInSection={null}
        childThreadsSection={null}
        expandedSection="status"
        onToggleSection={noop}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Machine cleanup failed" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByText(
        "This thread is unavailable while machine cleanup is pending. Retry cleanup in machine settings.",
      ),
    ).toBeDefined();
  });

  it.each([
    {
      label: "archived",
      archivedSection: { archivedAt: 1_731_456_000_000 },
      environmentGoneSection: null,
      expectedLabel: "Thread is archived",
    },
    {
      label: "environment archived",
      archivedSection: null,
      environmentGoneSection: { status: "destroyed" as const },
      expectedLabel: "Environment unavailable",
    },
  ])(
    "keeps the $label read-only status visible in compact mode",
    ({ archivedSection, environmentGoneSection, expectedLabel }) => {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <ThreadPromptContextBanner
            archivedSection={archivedSection}
            environmentGoneSection={environmentGoneSection}
            parentThreadSection={{
              parentThreadTitle: "Parent thread",
              href: "/threads/thr_parent",
              relationship: "parent",
            }}
            continuedInSection={null}
            childThreadsSection={null}
            expandedSection={null}
            onToggleSection={noop}
          />
        </MemoryRouter>,
      );

      expect(markup).toContain(expectedLabel);
      expect(markup).not.toContain(
        `data-promptbox-hide-compact="">${expectedLabel}`,
      );
    },
  );

  it("offers unarchiving first when an archived thread also lost its environment", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        archivedSection={{
          archivedAt: 1_731_456_000_000,
          onUnarchive: noop,
        }}
        environmentGoneSection={{ status: "destroyed" }}
        parentThreadSection={null}
        continuedInSection={null}
        childThreadsSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Environment unavailable");
    expect(markup).not.toContain("Thread is archived");
    expect(markup).toContain(">Unarchive<");
  });

  it("offers restoring the workspace once the thread is live again", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        archivedSection={null}
        environmentGoneSection={{ status: "destroyed", onRestore: noop }}
        parentThreadSection={null}
        continuedInSection={null}
        childThreadsSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Environment unavailable");
    expect(markup).toContain(">Restore workspace<");
  });

  it("shows the restore action as pending while it runs", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        archivedSection={null}
        environmentGoneSection={{
          status: "destroyed",
          onRestore: noop,
          restorePending: true,
        }}
        parentThreadSection={null}
        continuedInSection={null}
        childThreadsSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain(">Restoring...<");
    expect(markup).toContain("disabled");
  });

  it("summarizes child work without flashing the banner", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          continuedInSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_child",
                title: "Investigate failing checks",
                href: "/threads/thr_child",
                hasPendingInteraction: false,
              },
            ],
          }}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('aria-label="Child threads"');
    expect(markup).toContain(
      "1 active child thread: Investigate failing checks",
    );
    expect(markup).toContain("Active child thread:");
    expect(markup).toContain("Investigate failing checks");
    expect(markup).toContain('data-icon="UserRound"');
    expect(markup).toContain("animate-shine-icon");
    expect(markup).not.toContain("animate-shine font-medium");
  });

  it("summarizes additional active child threads", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          continuedInSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_primary",
                title: "Investigate failing checks",
                href: "/threads/thr_primary",
                hasPendingInteraction: false,
              },
              {
                id: "thr_other",
                title: "Review the release notes",
                href: "/threads/thr_other",
                hasPendingInteraction: false,
              },
            ],
          }}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain(
      "2 active child threads: Investigate failing checks",
    );
    expect(markup).toContain(">+1 more<");
  });

  it("lets combined child and context cards shrink inside the composer stack", () => {
    render(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={{
            parentThreadTitle: "Parent thread",
            href: "/threads/thr_parent",
            relationship: "parent",
          }}
          continuedInSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_child",
                title: "Host-owned SourceCode and Diff renderers",
                href: "/threads/thr_child",
                hasPendingInteraction: false,
              },
            ],
          }}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    const childCard = screen.getByRole("region", { name: "Child threads" });

    const contextCard = screen.getByRole("region", {
      name: "Thread context before sending",
    });

    expect(childCard.parentElement).toBe(contextCard.parentElement);
    expect(childCard.parentElement?.classList.contains("min-w-0")).toBe(true);
  });

  it("links a handoff back to the chat it continues", () => {
    render(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={{
            parentThreadTitle: "Fix the importer",
            href: "/projects/proj_1/threads/thr_source",
            relationship: "handoff",
          }}
          continuedInSection={null}
          childThreadsSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    const segment = screen.getByTitle("Continued from Fix the importer");
    expect(segment.textContent).toBe("Continued from Fix the importer");
    expect(
      screen
        .getByRole("link", { name: "Fix the importer" })
        .getAttribute("href"),
    ).toBe("/projects/proj_1/threads/thr_source");
  });

  it("links the source chat to the newest chat that continues it", () => {
    render(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          continuedInSection={{
            title: "Fix the importer on Fable",
            href: "/projects/proj_1/threads/thr_target",
            otherCount: 2,
          }}
          childThreadsSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    const segment = screen.getByTitle("Continued in Fix the importer on Fable");
    expect(segment.textContent).toBe(
      "Continued in Fix the importer on Fable+2 more",
    );
    expect(
      screen
        .getByRole("link", { name: "Fix the importer on Fable" })
        .getAttribute("href"),
    ).toBe("/projects/proj_1/threads/thr_target");
    expect(
      screen.getByLabelText("Also continued in 2 other threads"),
    ).toBeTruthy();
  });

  it("keeps Unarchive beside the Continued in link on an archived source", () => {
    render(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={{ archivedAt: 1_731_456_000_000, onUnarchive: noop }}
          environmentGoneSection={null}
          parentThreadSection={null}
          continuedInSection={{
            title: "Fix the importer on Fable",
            href: "/projects/proj_1/threads/thr_target",
            otherCount: 0,
          }}
          childThreadsSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Fix the importer on Fable" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("counts a child waiting for a host as active banner work", () => {
    expect(isThreadDisplayStatusBannerActive("waiting-for-host")).toBe(true);
  });

  it("labels a child blocked on approval instead of active work", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          continuedInSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_blocked",
                title: "Install workspace tools",
                href: "/threads/thr_blocked",
                hasPendingInteraction: true,
              },
            ],
          }}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain(
      "1 child thread needs input: Install workspace tools",
    );
    expect(markup).toContain("Needs your input:");
    expect(markup).toContain("Install workspace tools");
    expect(markup).toContain('data-icon="CircleQuestion"');
    expect(markup).not.toContain("Active child thread:");
    expect(markup).not.toContain("animate-shine-icon");
  });
});
