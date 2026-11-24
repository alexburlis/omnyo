// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginAuthorAvatar } from "./PluginAuthorAvatar";

afterEach(cleanup);

describe("PluginAuthorAvatar", () => {
  it("draws the Omnyo mark for plugins Omnyo wrote instead of a GitHub avatar", () => {
    render(
      <PluginAuthorAvatar
        name="Omnyo"
        github="alexburlis"
        omnyoLogo
        size="detail"
      />,
    );

    expect(screen.getByRole("img", { name: "Omnyo's avatar" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /GitHub avatar/u })).toBeNull();
  });

  it("uses the author's GitHub avatar for every other author", () => {
    render(<PluginAuthorAvatar name="Ada" github="ada" size="detail" />);

    expect(
      screen.getByRole("img", { name: "Ada's GitHub avatar" }),
    ).toBeTruthy();
  });
});
