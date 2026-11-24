// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Link, MemoryRouter } from "react-router-dom";
import { usePluginPageSidebar } from "./usePluginPageSidebar";

const routes = [
  "/",
  "/plugins/sentry/inbox",
  "/plugins/tasks/board/items",
  "/settings",
  "/plugins",
  "/plugins/canvas/p",
  "/plugins/canvas/p/project/h",
  "/plugins/canvas/p/project/s/section",
  "/plugins/chief/home",
];

function SidebarState({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [appOpen, setAppOpen] = useState(initiallyOpen);
  const [open, setOpen] = usePluginPageSidebar(appOpen, setAppOpen);

  return (
    <>
      <output aria-label="Chat list">{open ? "visible" : "hidden"}</output>
      <output aria-label="Chat preference">{String(appOpen)}</output>
      <button onClick={() => setOpen(!open)}>Toggle sidebar</button>
      {routes.map((route) => (
        <Link key={route} to={route}>
          {route}
        </Link>
      ))}
    </>
  );
}

afterEach(cleanup);

describe("plugin page sidebar", () => {
  it.each([true, false])(
    "collapses plugin pages and restores the %s chat preference",
    (initiallyOpen) => {
      render(
        <MemoryRouter>
          <SidebarState initiallyOpen={initiallyOpen} />
        </MemoryRouter>,
      );
      const state = () => screen.getByLabelText("Chat list").textContent;

      const visit = (route: string) =>
        fireEvent.click(screen.getByRole("link", { name: route }));

      for (const route of routes.slice(1, 3)) {
        visit(route);
        expect(state()).toBe("hidden");
        fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
        expect(state()).toBe("visible");
        expect(screen.getByLabelText("Chat preference").textContent).toBe(
          String(initiallyOpen),
        );
      }

      for (const route of ["/", "/settings", "/plugins"]) {
        visit(route);
        expect(state()).toBe(initiallyOpen ? "visible" : "hidden");
      }

      visit(routes[1]!);
      expect(state()).toBe("hidden");
    },
  );

  it("collapses a plugin deep link before the first render", () => {
    render(
      <MemoryRouter initialEntries={[routes[2]!]}>
        <SidebarState initiallyOpen />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Chat list").textContent).toBe("hidden");
  });

  it.each([true, false])(
    "keeps the %s chat sidebar preference on Canvas and Needs you routes",
    (initiallyOpen) => {
      render(
        <MemoryRouter>
          <SidebarState initiallyOpen={initiallyOpen} />
        </MemoryRouter>,
      );
      const state = () => screen.getByLabelText("Chat list").textContent;

      const visit = (route: string) =>
        fireEvent.click(screen.getByRole("link", { name: route }));

      for (const route of routes.slice(5)) {
        visit(route);
        expect(state()).toBe(initiallyOpen ? "visible" : "hidden");
      }

      fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      visit(routes[5]!);
      expect(state()).toBe(initiallyOpen ? "hidden" : "visible");
      visit("/");
      expect(state()).toBe(initiallyOpen ? "hidden" : "visible");
    },
  );
});
