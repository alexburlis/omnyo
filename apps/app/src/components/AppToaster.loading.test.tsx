// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { AppToaster } from "./AppToaster";
import { appToast } from "./ui/app-toast";
import { whenToasterSettled } from "./ui/app-toast-runtime";

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("settles a failed load and shows only a new toast after the download recovers", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let available = false;

  const fetch = vi.fn(async () => ({
    ok: available,
    status: available ? 200 : 503,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));

  vi.stubGlobal("fetch", fetch);
  const manifest = document.createElement("script");
  manifest.id = "omnyo-prefetch-manifest";
  manifest.type = "application/json";
  manifest.textContent = JSON.stringify({
    files: ["/assets/app-toaster-recovery.js"],
    splits: { "app-toaster": [0] },
  });
  document.head.append(manifest);

  try {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <AppToaster />
      </CompactViewportOverrideProvider>,
    );
    expect(document.querySelector("[data-sonner-toaster]")).toBeNull();
    act(() => {
      appToast.success("Notification from the failed attempt");
    });
    const settled = vi.fn();
    void whenToasterSettled().then(settled);
    await waitFor(() => expect(settled).toHaveBeenCalledOnce(), {
      timeout: 4000,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(document.querySelector("[data-sonner-toaster]")).toBeNull();

    available = true;
    act(() => {
      appToast.success("Saved before the toaster loaded");
    });
    await waitFor(() =>
      expect(
        document.body.textContent?.includes("Saved before the toaster loaded"),
      ).toBe(true),
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).not.toContain(
      "Notification from the failed attempt",
    );
  } finally {
    manifest.remove();
  }
});
