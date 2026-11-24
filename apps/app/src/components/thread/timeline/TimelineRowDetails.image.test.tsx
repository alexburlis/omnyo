// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { imageViewRow } from "@/test/fixtures/thread-timeline-rows";
import { WorkRowBody } from "./TimelineRowDetails";

afterEach(cleanup);

const ORIGINAL = "/api/v1/threads/thread-1/host-files/tmp/dashboard-main.png";

function inlineImage() {
  const image = screen
    .getByRole("button", { name: "Open image preview: dashboard-main.png" })
    .querySelector("img");

  if (image === null) throw new Error("Missing inline image");

  return image;
}

it("shows viewed images from a 960 derivative and opens the exact original", async () => {
  render(
    <WorkRowBody
      row={imageViewRow({ threadId: "thread-1" })}
      workspaceRootPath={undefined}
    />,
  );

  const image = inlineImage();
  expect(image.getAttribute("src")).toBe(`${ORIGINAL}?thumbnailWidth=960`);
  expect(image.getAttribute("srcset")).toBeNull();
  fireEvent.click(image);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

  const original = within(screen.getByRole("dialog")).getByRole("img", {
    name: "Viewed image: dashboard-main.png",
  });

  expect(original.getAttribute("src")).toBe(ORIGINAL);
});

it("keeps generated images on their exact original", () => {
  render(
    <WorkRowBody
      row={{
        ...imageViewRow({ threadId: "thread-1" }),
        workKind: "image-generation",
        prompt: null,
        error: null,
        transparentBackground: false,
      }}
      workspaceRootPath={undefined}
    />,
  );

  expect(inlineImage().getAttribute("src")).toBe(ORIGINAL);
});
