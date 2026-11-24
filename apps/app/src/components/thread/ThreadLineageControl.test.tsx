// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { ThreadLineageControl } from "./ThreadLineageControl";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";

afterEach(cleanup);

it("keeps one distinct navigable control for each continuation direction", () => {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ThreadLineageControl
          source={{
            relationship: "handoff",
            href: "/source",
            parentThreadTitle: "Source chat",
          }}
          destinations={[{ href: "/destination", title: "Destination chat" }]}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
  expect(
    screen
      .getByRole("link", { name: "Continued from Source chat" })
      .getAttribute("href"),
  ).toBe("/source");
  expect(
    screen
      .getByRole("link", { name: "Continued in Destination chat" })
      .getAttribute("href"),
  ).toBe("/destination");
  expect(screen.getAllByRole("link")).toHaveLength(2);
});

it("opens every continuation from one header control", async () => {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ThreadLineageControl
          source={null}
          destinations={[
            { href: "/newer", title: "Newer chat" },
            { href: "/older", title: "Older chat" },
          ]}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Continued in 2 chats" }));
  expect(
    (await screen.findByRole("link", { name: "Newer chat" })).getAttribute(
      "href",
    ),
  ).toBe("/newer");
  expect(
    screen.getByRole("link", { name: "Older chat" }).getAttribute("href"),
  ).toBe("/older");
  expect(screen.getAllByRole("link")).toHaveLength(2);
});

function CurrentRoute() {
  return <output>{useLocation().pathname}</output>;
}

it("renders actionable continuation links in the compact drawer", async () => {
  render(
    <MemoryRouter>
      <CurrentRoute />
      <CompactViewportOverrideProvider isCompactViewport>
        <TooltipProvider>
          <ThreadLineageControl
            source={null}
            destinations={[
              { href: "/newer", title: "Newer chat" },
              { href: "/older", title: "Older chat" },
            ]}
          />
        </TooltipProvider>
      </CompactViewportOverrideProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Continued in 2 chats" }));
  const link = await screen.findByRole("link", { name: "Older chat" });
  expect(link.closest("button")).toBeNull();
  expect(link.getAttribute("href")).toBe("/older");
  fireEvent.click(link);
  expect(screen.getByText("/older")).toBeTruthy();
});
