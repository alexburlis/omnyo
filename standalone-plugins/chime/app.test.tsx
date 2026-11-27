// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { DEFAULT_CONFIG, SOUND_IDS } from "./domain";

describe("Chime settings UI", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders playback, events, and project muting", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfig: () => ({
            config: DEFAULT_CONFIG,
            projects: [{ id: "project-1", name: "Example project" }],
            serverPlaybackAvailable: true,
          }),
          updateConfig: (config) => ({ config }),
          previewServer: () => ({ ok: true, error: null }),
        },
      },
    );

    expect(await slot.findByText("Playback")).toBeTruthy();
    expect(await slot.findByText("Turn completed")).toBeTruthy();
    expect(await slot.findByText("Example project")).toBeTruthy();

    const themeSelect = slot.getByLabelText("Sound theme") as HTMLSelectElement;
    expect(themeSelect.value).toBe("omnyo");
    fireEvent.change(themeSelect, { target: { value: "glass" } });
    expect(themeSelect.value).toBe("glass");

    const completedSound = slot.getByLabelText("Turn completed sound") as HTMLSelectElement;
    expect(Array.from(completedSound.options, (option) => option.value).sort()).toEqual(
      [...SOUND_IDS].sort(),
    );
    fireEvent.change(completedSound, { target: { value: "wood-resolve" } });
    expect(themeSelect.value).toBe("custom");
    slot.lifecycle.unmount();
  });

  it("previews its own sound without depending on external Chime", async () => {
    const played: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        volume = 0;
        constructor(private readonly url: string) {}
        async play() {
          played.push(this.url);
        }
      },
    );
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        pluginId: "chime-local",
        rpc: {
          getConfig: () => ({
            config: DEFAULT_CONFIG,
            projects: [],
            serverPlaybackAvailable: false,
          }),
        },
      },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Preview completion" }));
      await waitFor(() =>
        expect(played).toEqual(["/api/v1/plugins/chime-local/http/sound-omnyo-resolve"]),
      );
      expect(await slot.findByText("Client audio enabled")).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
