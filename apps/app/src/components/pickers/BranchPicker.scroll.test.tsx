// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPicker } from "./BranchPicker";
import { expectNonmodalPicker } from "@/test/nonmodal-picker";

afterEach(cleanup);

describe("BranchPicker modality", () => {
  it("keeps the page interactive and closes when focus leaves", async () => {
    render(<BranchPicker value="main" options={["main"]} onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "Branch" });
    await expectNonmodalPicker({
      trigger,
      open: () => fireEvent.click(trigger),
      content: () => screen.queryByPlaceholderText("Search branches"),
    });
  });
});

describe("BranchPicker search", () => {
  it("uses fuzzy matching and returns the results viewport to the top", () => {
    render(
      <BranchPicker
        value="main"
        options={[
          "main",
          "develop",
          "feature/one",
          "feature/two",
          "feature/three",
        ]}
        onChange={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    const search = screen.getByPlaceholderText("Search branches");
    const scrollArea = search.parentElement?.parentElement?.nextElementSibling;
    expect(scrollArea).toBeInstanceOf(HTMLElement);

    if (!(scrollArea instanceof HTMLElement)) return;
    scrollArea.scrollTop = 120;

    fireEvent.change(search, { target: { value: "fth" } });

    expect(scrollArea.scrollTop).toBe(0);
    expect(screen.getByText("feature/three")).toBeTruthy();
    expect(screen.queryByText("feature/two")).toBeNull();
  });

  it("uses relevance order instead of pinning the selected match", () => {
    const selectedBranch = "super-feature/three-compatibility";
    const directBranch = "feature/three";
    render(
      <BranchPicker
        value={selectedBranch}
        options={[selectedBranch, directBranch]}
        onChange={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    fireEvent.change(screen.getByPlaceholderText("Search branches"), {
      target: { value: "fth" },
    });

    const directResult = screen.getByText(directBranch);
    const selectedResult = screen.getAllByText(selectedBranch).at(-1);
    expect(selectedResult).toBeTruthy();

    if (!selectedResult) return;
    expect(
      directResult.compareDocumentPosition(selectedResult) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps an empty result in the branches section", () => {
    render(
      <BranchPicker
        value={null}
        options={[]}
        onChange={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));

    expect(screen.getByText("Branches")).toBeTruthy();
    expect(
      screen
        .getByText("No branches found.")
        .closest("[data-picker-empty-state]")?.className,
    ).toContain("py-3");
  });

  it("lists remote branches under their own header and selects a local match on Enter", () => {
    const onChange = vi.fn();
    render(
      <BranchPicker
        value={null}
        options={["main", "release/main-fixes"]}
        remoteOptions={["origin/main"]}
        onChange={onChange}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));

    const remoteHeader = screen.getByText("Remote branches");
    expect(
      screen
        .getByTitle("release/main-fixes")
        .compareDocumentPosition(remoteHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      remoteHeader.compareDocumentPosition(
        screen.getByTitle("origin/main (remote branch)"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    const search = screen.getByPlaceholderText("Search branches");
    fireEvent.change(search, { target: { value: "main" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("main");
  });
});
