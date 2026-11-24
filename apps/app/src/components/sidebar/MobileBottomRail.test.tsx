// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileBottomRail } from "./MobileBottomRail";

afterEach(cleanup);

describe("MobileBottomRail", () => {
  it("renders only the settings and actions row, with no server row above it", () => {
    render(
      <MobileBottomRail settings={<button type="button">Settings</button>}>
        <button type="button">Action</button>
      </MobileBottomRail>,
    );

    const rail = screen.getByTestId("sidebar-bottom-rail");

    expect(rail.children).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Action" })).toBeDefined();
    expect(screen.queryByTestId("sidebar-native-server")).toBeNull();
  });
});
