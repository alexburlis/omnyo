// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedSendForecastHint } from "./QueuedSendForecastHint";

vi.mock("@/components/plugin/PluginIcon", () => ({ PluginIcon: () => null }));

vi.mock("@/lib/plugin-logos", () => ({
  usePluginDisplayName: (id: string) => id,
}));

vi.mock("@/hooks/useSecondTick", () => ({ useSecondTick: () => 0 }));

afterEach(cleanup);

describe("QueuedSendForecastHint", () => {
  it.each([
    { pluginId: "concurrency-limit", visible: false },
    { pluginId: "drafts", visible: true },
  ])(
    "shows the $pluginId forecast in the rail: $visible",
    ({ pluginId, visible }) => {
      render(
        <QueuedSendForecastHint
          forecast={{
            waitingOn: {
              kind: "plugin",
              pluginId,
              reason: "Waiting for admission",
            },
            sendAt: null,
          }}
        />,
      );
      expect(screen.queryByRole("status") !== null).toBe(visible);

      if (visible)
        expect(screen.getByRole("status").textContent).toContain(
          "Waiting for admission",
        );
    },
  );

  it("keeps host-offline guidance visible", () => {
    render(
      <QueuedSendForecastHint
        forecast={{
          waitingOn: { kind: "host-offline", hostName: "Mac Pro" },
          sendAt: null,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Mac Pro");
  });
});
