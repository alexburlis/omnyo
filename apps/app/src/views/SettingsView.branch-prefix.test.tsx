// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { defaultAppSettings, type AppSettings } from "@omnyo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeneralSettingsSection,
  PrivacySettingsSection,
} from "@/components/settings/GeneralSettingsPage";

afterEach(cleanup);

function renderSection({
  desktopBrowserAvailable = false,
  onSettingsChange = vi.fn(),
  onManagedBranchPrefixChange = vi.fn(),
  ...overrides
}: Partial<AppSettings> & {
  desktopBrowserAvailable?: boolean;
  onSettingsChange?: (patch: Partial<AppSettings>) => void;
  onManagedBranchPrefixChange?: (prefix: string) => void;
} = {}) {
  const settings = {
    ...defaultAppSettings,
    telemetryEnabled: true,
    crashReportsEnabled: true,
    confirmThreadArchive: true,
    compactExpiredCache: true,
    managedBranchPrefix: "omnyo/",
    ...overrides,
  };

  return render(
    <>
      <GeneralSettingsSection
        settings={settings}
        disabled={false}
        onSettingsChange={onSettingsChange}
        desktopBrowserAvailable={desktopBrowserAvailable}
        onManagedBranchPrefixChange={onManagedBranchPrefixChange}
        navigateToThreadAfterCreate={false}
        onNavigateToThreadAfterCreateChange={vi.fn()}
        openLinksInAppBrowser={false}
        onOpenLinksInAppBrowserChange={vi.fn()}
        rewriteLocalhostLinks={false}
        onRewriteLocalhostLinksChange={vi.fn()}
      />
      <PrivacySettingsSection
        settings={settings}
        disabled={false}
        onSettingsChange={onSettingsChange}
      />
    </>,
  );
}

function branchPrefixInput() {
  const input = screen.getByLabelText("New branch prefix");

  if (!(input instanceof HTMLInputElement)) {
    throw new Error("New branch prefix control is not an input");
  }

  return input;
}

describe("new branch prefix setting", () => {
  it("saves a valid prefix on Enter", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "sawyer/wt-" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("sawyer/wt-");
  });

  it("saves an empty prefix", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("restores the saved value when saving fails", async () => {
    const failedSave = Promise.reject(new Error("write failed"));
    void failedSave.catch(() => undefined);
    const onChange = vi.fn(() => failedSave);
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "team/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("omnyo/"));
  });

  it("refuses an invalid prefix and restores the saved value", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "bad prefix/" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("omnyo/");
  });

  it("reverts the draft on Escape", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "sawyer/" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("omnyo/");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("localhost link rewrite setting", () => {
  it("offers device-aware routing on localhost too", () => {
    renderSection();
    expect(screen.getByText("Rewrite localhost links")).not.toBeNull();
    expect(screen.getByText("Links")).not.toBeNull();
  });

  it("keeps the Links section for the in-app browser setting", () => {
    renderSection({ desktopBrowserAvailable: true });
    expect(screen.getByText("Links")).not.toBeNull();
    expect(screen.getByText("Rewrite localhost links")).not.toBeNull();
  });
});

it("shows the saved telemetry preference and allows opting out", () => {
  const onChange = vi.fn();
  renderSection({ onSettingsChange: onChange });

  const toggle = screen.getByRole("switch", {
    name: "Share anonymous usage data",
  });

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith({ telemetryEnabled: false });
  cleanup();
  renderSection({ telemetryEnabled: false });
  expect(
    screen
      .getByRole("switch", { name: "Share anonymous usage data" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

it("shows the saved crash reports preference and allows opting out", () => {
  const onChange = vi.fn();
  renderSection({ onSettingsChange: onChange });

  const toggle = screen.getByRole("switch", { name: "Crash reports" });

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith({ crashReportsEnabled: false });
  cleanup();
  renderSection({ crashReportsEnabled: false });
  expect(
    screen
      .getByRole("switch", { name: "Crash reports" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

it("allows disabling archive confirmation and shows the saved preference", () => {
  const onChange = vi.fn();
  renderSection({ onSettingsChange: onChange });

  const toggle = screen.getByRole("switch", {
    name: "Thread archive confirmation",
  });

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith({ confirmThreadArchive: false });
  cleanup();
  renderSection({ confirmThreadArchive: false });
  expect(
    screen
      .getByRole("switch", { name: "Thread archive confirmation" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

it("shows the saved compact-before-resume preference and allows turning it off", () => {
  const onChange = vi.fn();
  renderSection({ onSettingsChange: onChange });

  const toggle = screen.getByRole("switch", {
    name: "Offer to compact before resuming expired sessions",
  });

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith({ compactExpiredCache: false });
  cleanup();
  renderSection({ compactExpiredCache: false });
  expect(
    screen
      .getByRole("switch", {
        name: "Offer to compact before resuming expired sessions",
      })
      .getAttribute("aria-checked"),
  ).toBe("false");
});
