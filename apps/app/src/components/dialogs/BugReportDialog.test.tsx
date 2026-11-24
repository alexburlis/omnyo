// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { defaultAppSettings } from "@omnyo/domain";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  BugReportDialog,
  resolveBugReportUnavailableReason,
} from "./BugReportDialog";

const mocks = vi.hoisted(() => ({
  config: undefined as unknown,
  lastEventId: null as string | null,
  reportBug: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: mocks.config }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { system: { experimental_reportBug: mocks.reportBug } },
}));

vi.mock("@/lib/web-error-reporting", () => ({
  readLastDeliveredWebErrorEventId: () => mocks.lastEventId,
}));

const settings = { ...defaultAppSettings, showUnhandledProviderEvents: false };

const readyConfig = {
  generalSettings: settings,
  diagnostics: {
    release: "0.46.300+private.1",
    sentryDsn: "https://public@sentry.example.invalid/42",
  },
};

const LAST_EVENT_ID = "0123456789abcdef0123456789abcdef";

function renderDialog() {
  const onOpenChange = vi.fn();
  const { wrapper: Wrapper } = createQueryClientTestHarness();

  render(
    <Wrapper>
      <MemoryRouter>
        <BugReportDialog open onOpenChange={onOpenChange} />
      </MemoryRouter>
    </Wrapper>,
  );

  return { onOpenChange };
}

function typeReport(message: string, email = "") {
  fireEvent.change(screen.getByLabelText("What went wrong?"), {
    target: { value: message },
  });
  fireEvent.change(screen.getByLabelText("Email for follow-up (optional)"), {
    target: { value: email },
  });
}

beforeEach(() => {
  mocks.config = readyConfig;
  mocks.lastEventId = null;
  mocks.reportBug.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("resolveBugReportUnavailableReason", () => {
  it("needs a DSN first, then the Crash reports setting", () => {
    expect(resolveBugReportUnavailableReason(undefined)).toBeNull();
    expect(resolveBugReportUnavailableReason(readyConfig)).toBeNull();
    expect(
      resolveBugReportUnavailableReason({
        generalSettings: { ...settings, crashReportsEnabled: false },
        diagnostics: { release: "0.46.300+private.1" },
      }),
    ).toBe("not-configured");
    expect(
      resolveBugReportUnavailableReason({
        ...readyConfig,
        generalSettings: { ...settings, crashReportsEnabled: false },
      }),
    ).toBe("crash-reports-off");
  });
});

describe("BugReportDialog", () => {
  it("sends the note, email and last delivered error, then shows the reference", async () => {
    mocks.lastEventId = LAST_EVENT_ID;
    mocks.reportBug.mockResolvedValue({ status: "sent", reportId: "abc123" });
    renderDialog();

    typeReport("  The sidebar froze  ", " person@example.test ");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(
      await screen.findByRole("heading", { name: "Report sent" }),
    ).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();
    expect(mocks.reportBug).toHaveBeenCalledWith({
      message: "The sidebar froze",
      email: "person@example.test",
      associatedEventId: LAST_EVENT_ID,
    });
  });

  it("keeps the note and shows the failure when sending fails", async () => {
    mocks.reportBug.mockRejectedValue(
      new Error("Sentry did not answer in time. Try again."),
    );
    renderDialog();

    typeReport("It broke");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't send the report. Sentry did not answer in time. Try again.",
    );
    expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
    expect(
      (screen.getByLabelText("What went wrong?") as HTMLTextAreaElement).value,
    ).toBe("It broke");
  });

  it("rejects an invalid email without sending", () => {
    renderDialog();

    typeReport("It broke", "not-an-email");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a valid email address, or leave it empty.",
    );
    expect(mocks.reportBug).not.toHaveBeenCalled();
  });

  it("says plainly that reports are off and offers no form", () => {
    mocks.config = {
      ...readyConfig,
      generalSettings: { ...settings, crashReportsEnabled: false },
    };
    renderDialog();

    expect(screen.getByRole("dialog").textContent).toContain(
      "Bug reports are off because Crash reports is off in Settings.",
    );
    expect(screen.queryByLabelText("What went wrong?")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
  });

  it("says when the server is not set up to send reports", () => {
    mocks.config = {
      generalSettings: settings,
      diagnostics: { release: "0.46.300+private.1" },
    };
    renderDialog();

    expect(screen.getByRole("dialog").textContent).toContain(
      "This Omnyo server isn't set up to send bug reports.",
    );
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
  });

  it("switches to the unavailable message when the server refuses", async () => {
    mocks.reportBug.mockResolvedValue({
      status: "unavailable",
      reason: "crash-reports-off",
    });
    renderDialog();

    typeReport("It broke");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Bug reports are off because Crash reports is off in Settings.",
      ),
    );
    expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
  });
});
