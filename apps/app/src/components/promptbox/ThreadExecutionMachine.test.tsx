// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadExecutionMachine } from "./ThreadExecutionMachine";

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [
      { id: "viewer", name: "Viewer machine", status: "connected" },
      { id: "session", name: "Execution machine", status: "disconnected" },
    ],
    isPending: false,
  }),
}));

afterEach(cleanup);

it("identifies the bound execution machine and its disconnected state", () => {
  render(<ThreadExecutionMachine hostId="session" />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Execution machine: Execution machine",
    }),
  );
  expect(screen.getByText("Execution machine")).toBeTruthy();
  expect(screen.getByText(/Disconnected/)).toBeTruthy();
  expect(screen.queryByText("Viewer machine")).toBeNull();
});
