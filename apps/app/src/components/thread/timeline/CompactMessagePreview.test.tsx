// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThreadTitleMentionResourcesProvider } from "../ThreadTitleMentions";
import { CompactMessagePreview } from "./CompactMessagePreview";

afterEach(cleanup);

it("resolves serialized and stored mentions without nested links", () => {
  const text = "Continue from @thread:thr_source and this-file";

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTitleMentionResourcesProvider
          projectNamesById={new Map()}
          sectionNamesById={new Map()}
          threadById={
            new Map([
              [
                "thr_source",
                {
                  id: "thr_source",
                  title: "Source chat",
                  titleFallback: "Source",
                  projectId: "project",
                },
              ],
            ])
          }
        >
          <button type="button">
            <CompactMessagePreview
              text={text}
              mentions={[
                {
                  start: text.indexOf("this-file"),
                  end: text.length,
                  resource: {
                    kind: "attachment",
                    path: "/tmp/source.ts",
                    label: "source.ts",
                  },
                },
              ]}
            />
          </button>
        </ThreadTitleMentionResourcesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(screen.getByText("Source chat")).toBeTruthy();
  expect(screen.getByText("source.ts")).toBeTruthy();
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).not.toContain("@thread:");
});

it("leaves code literals and email addresses intact", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CompactMessagePreview text="Use `@thread:literal` and me@example.com" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText("@thread:literal").tagName).toBe("CODE");
  expect(screen.getByText(/me@example.com/)).toBeTruthy();
});
