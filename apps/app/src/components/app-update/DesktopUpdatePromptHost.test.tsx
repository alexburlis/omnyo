// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import type {
  OmnyoDesktopApi,
  OmnyoDesktopInfo,
} from "@omnyo/desktop-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppToasterView } from "@/components/AppToasterView";
import { createOmnyoDesktopApi } from "@/test/omnyo-desktop-test-utils";
import { DesktopUpdatePromptHost } from "./DesktopUpdatePromptHost";

const downloaded: OmnyoDesktopInfo = {
  downloadState: "downloaded",
  lastCheckedAt: "2026-10-18T10:00:00.000Z",
  latestVersion: "0.46.20",
  pendingVersion: "0.46.20",
  platform: "macos",
  updateAvailable: true,
  updateDownloaded: true,
  version: "0.46.19",
};

afterEach(() => {
  vi.restoreAllMocks();
  toast.dismiss();
  cleanup();
  delete window.omnyoDesktop;
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.omnyoStorageMigrationError;
});

function installDesktop(info: OmnyoDesktopInfo) {
  const listeners = new Set<(next: OmnyoDesktopInfo) => void>();
  const installUpdate = vi.fn(async () => {});

  const api: OmnyoDesktopApi = {
    ...createOmnyoDesktopApi(info),
    installUpdate,
    onChange(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  window.omnyoDesktop = api;

  return {
    installUpdate,
    emit(next: OmnyoDesktopInfo) {
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

function renderWithToaster() {
  render(<AppToasterView />);

  return render(<DesktopUpdatePromptHost />);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
}

describe("DesktopUpdatePromptHost", () => {
  it("offers Relaunch and Later once the desktop update is downloaded", async () => {
    installDesktop(downloaded);
    renderWithToaster();

    expect(await screen.findByText("Update ready")).toBeDefined();
    expect(screen.getByText(/0\.46\.20/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Relaunch" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Later" })).toBeDefined();
  });

  it("relaunches into the downloaded update", async () => {
    const desktop = installDesktop(downloaded);
    renderWithToaster();

    fireEvent.click(await screen.findByRole("button", { name: "Relaunch" }));

    expect(desktop.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows why the desktop app refused to relaunch", async () => {
    const desktop = installDesktop(downloaded);
    desktop.installUpdate.mockRejectedValue(
      new Error("Private update admission is already held"),
    );
    renderWithToaster();

    fireEvent.click(await screen.findByRole("button", { name: "Relaunch" }));

    expect(await screen.findByText("Relaunch failed")).toBeDefined();
    expect(
      screen.getByText("Private update admission is already held"),
    ).toBeDefined();
  });

  it("keeps Later for that version until a newer update downloads", async () => {
    const desktop = installDesktop(downloaded);
    const host = renderWithToaster();

    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByText("Update ready")).toBeNull());
    host.unmount();
    render(<DesktopUpdatePromptHost />);
    await settle();

    expect(screen.queryByText("Update ready")).toBeNull();

    desktop.emit({
      ...downloaded,
      latestVersion: "0.46.21",
      pendingVersion: "0.46.21",
    });

    expect(await screen.findByText("Update ready")).toBeDefined();
    expect(screen.getByText(/0\.46\.21/)).toBeDefined();
  });

  it("withdraws the prompt when the downloaded update goes away", async () => {
    const desktop = installDesktop(downloaded);
    renderWithToaster();
    await screen.findByText("Update ready");

    desktop.emit({
      ...downloaded,
      downloadState: "idle",
      updateDownloaded: false,
    });

    await waitFor(() => expect(screen.queryByText("Update ready")).toBeNull());
  });

  it("stays quiet outside the desktop app and before a download finishes", async () => {
    renderWithToaster();
    await settle();

    expect(screen.queryByText("Update ready")).toBeNull();

    cleanup();
    installDesktop({
      ...downloaded,
      downloadState: "downloading",
      updateDownloaded: false,
    });
    renderWithToaster();
    await settle();

    expect(screen.queryByText("Update ready")).toBeNull();
  });
});

describe("Later preference finite V1 admission", () => {
  async function migration() {
    delete document.documentElement.dataset.omnyoStorageMigrationError;

    return import("@/lib/legacy-browser-storage-v1");
  }

  it("adopts the exact old Later value before prompt admission and repeats without rewriting", async () => {
    const raw = "0.46.20";
    window.localStorage.setItem("bb.desktopUpdateLaterVersion", raw);
    const owner = await migration();
    owner.assertBrowserStorageMigrationV1();
    expect(window.localStorage.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      raw,
    );
    expect(
      window.localStorage.getItem("bb.desktopUpdateLaterVersion"),
    ).toBeNull();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    owner.assertBrowserStorageMigrationV1();
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    installDesktop(downloaded);
    renderWithToaster();
    await settle();
    expect(screen.queryByText("Update ready")).toBeNull();
  });

  it("refuses unequal Later authorities before any mutation", async () => {
    window.localStorage.setItem("bb.desktopUpdateLaterVersion", "0.46.20");
    window.localStorage.setItem("omnyo.desktopUpdateLaterVersion", "0.46.21");
    window.localStorage.setItem(
      "opaque.plugin.workspace",
      '{"text":"bb.user bytes stay unchanged"}',
    );
    const owner = await migration();
    expect(() =>
      owner.migrateLegacyBrowserStorageV1({
        local: window.localStorage,
        session: window.sessionStorage,
      }),
    ).toThrow(/conflict/);
    expect(window.localStorage.getItem("bb.desktopUpdateLaterVersion")).toBe(
      "0.46.20",
    );
    expect(window.localStorage.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      "0.46.21",
    );
    expect(window.localStorage.getItem("opaque.plugin.workspace")).toBe(
      '{"text":"bb.user bytes stay unchanged"}',
    );
  });

  it("keeps the raw Later value when quota refuses its copy and resumes the same plan", async () => {
    const raw = "0.46.20+private.1";
    window.localStorage.setItem("bb.desktopUpdateLaterVersion", raw);
    const owner = await migration();
    const original = Storage.prototype.setItem;

    const writes = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "omnyo.desktopUpdateLaterVersion")
          throw new DOMException("fixture quota", "QuotaExceededError");

        return original.call(this, key, value);
      });

    expect(() =>
      owner.migrateLegacyBrowserStorageV1({
        local: window.localStorage,
        session: window.sessionStorage,
      }),
    ).toThrow(/quota/);
    expect(window.localStorage.getItem("bb.desktopUpdateLaterVersion")).toBe(
      raw,
    );
    expect(
      window.localStorage.getItem("omnyo.desktopUpdateLaterVersion"),
    ).toBeNull();
    writes.mockRestore();
    owner.migrateLegacyBrowserStorageV1({
      local: window.localStorage,
      session: window.sessionStorage,
    });
    expect(window.localStorage.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      raw,
    );
    expect(
      window.localStorage.getItem("bb.desktopUpdateLaterVersion"),
    ).toBeNull();
  });

  it("collapses equal Later copies without replacing their raw bytes", async () => {
    const raw = "0.46.20+private.1";
    window.localStorage.setItem("bb.desktopUpdateLaterVersion", raw);
    window.localStorage.setItem("omnyo.desktopUpdateLaterVersion", raw);
    const owner = await migration();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    owner.migrateLegacyBrowserStorageV1({
      local: window.localStorage,
      session: window.sessionStorage,
    });
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(window.localStorage.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      raw,
    );
    expect(
      window.localStorage.getItem("bb.desktopUpdateLaterVersion"),
    ).toBeNull();
  });

  it("refuses an invalid empty Later value before admission", async () => {
    window.localStorage.setItem("bb.desktopUpdateLaterVersion", "");
    const owner = await migration();
    expect(() =>
      owner.migrateLegacyBrowserStorageV1({
        local: window.localStorage,
        session: window.sessionStorage,
      }),
    ).toThrow(/invalid/);
    expect(window.localStorage.getItem("bb.desktopUpdateLaterVersion")).toBe(
      "",
    );
    expect(
      window.localStorage.getItem("omnyo.desktopUpdateLaterVersion"),
    ).toBeNull();
  });

  it("keeps prompt mount reads pure and writes fresh Later only to the canonical key", async () => {
    installDesktop(downloaded);
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const removes = vi.spyOn(Storage.prototype, "removeItem");
    renderWithToaster();
    const later = await screen.findByRole("button", { name: "Later" });
    expect(
      sets.mock.calls.filter(([key]) => /desktopUpdateLaterVersion$/.test(key)),
    ).toHaveLength(0);
    expect(
      removes.mock.calls.filter(([key]) =>
        /desktopUpdateLaterVersion$/.test(key),
      ),
    ).toHaveLength(0);
    fireEvent.click(later);
    await waitFor(() => expect(screen.queryByText("Update ready")).toBeNull());
    expect(window.localStorage.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      "0.46.20",
    );
    expect(
      window.localStorage.getItem("bb.desktopUpdateLaterVersion"),
    ).toBeNull();
    sets.mockRestore();
    removes.mockRestore();
  });
});
