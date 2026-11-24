// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QuestionForm } from "./question-form";

afterEach(cleanup);

it("renders the selected image and sanitized HTML in the answer form", async () => {
  const slot = render(
    <QuestionForm
      threadId="thr_preview"
      questions={[
        {
          id: "layout",
          prompt: "Which layout?",
          shortLabel: "Layout",
          multiSelect: false,
          allowFreeText: false,
          options: [
            {
              value: "image",
              label: "Image",
              preview: "![Launchpad layout](/workspace/launchpad.png)",
            },
            {
              value: "html",
              label: "HTML",
              preview: "<h3>List layout</h3><script>untrusted()</script>",
            },
            { value: "code", label: "Code", preview: "A  |  B" },
          ],
        },
      ]}
      disabled={false}
      cancelDisabled={false}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );

  fireEvent.click(slot.getByRole("radio", { name: "Image" }));
  expect(
    (await slot.findByAltText("Launchpad layout")).getAttribute("src"),
  ).toContain("/thr_preview/host-files/workspace/launchpad.png");
  fireEvent.click(slot.getByRole("radio", { name: "HTML" }));
  expect(
    await slot.findByRole("heading", { name: "List layout" }),
  ).toBeTruthy();
  expect(slot.queryByAltText("Launchpad layout")).toBeNull();
  expect(slot.container.querySelector("script")).toBeNull();
  fireEvent.click(slot.getByRole("radio", { name: "Code" }));
  expect(slot.container.querySelector("pre")?.textContent).toBe("A  |  B");
});
