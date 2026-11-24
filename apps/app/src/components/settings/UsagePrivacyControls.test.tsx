// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { readClientUsageConsent } from "@/lib/usage-consent";
import { UsagePrivacyControls } from "./UsagePrivacyControls";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      experimental_usageStatus: vi.fn(),
      experimental_usageConsent: vi.fn(),
      experimental_usagePreview: vi.fn(),
      experimental_eraseUsageAnalytics: vi.fn(),
    },
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("usage privacy settings", () => {
  it("grants and withdraws only this client and keeps the count choice independent", async () => {
    const proof = "a".repeat(64);

    const status = {
      count: {
        choice: "declined",
        effective: false,
        reason: "declined",
        noticeRequired: false,
        attemptedWeek: null,
      },
      product: {
        choice: "unset",
        effective: false,
        reason: "consent-required",
        erasure: "none",
        rawRetentionDays: 30,
      },
    } as const;

    vi.mocked(sdk.system.experimental_usageStatus).mockResolvedValue(status);
    vi.mocked(sdk.system.experimental_usageConsent)
      .mockResolvedValueOnce({
        status: {
          ...status,
          product: {
            ...status.product,
            choice: "granted",
            effective: true,
            reason: "granted",
          },
        },
        proof,
      })
      .mockResolvedValueOnce({
        status: {
          ...status,
          product: {
            ...status.product,
            choice: "declined",
            reason: "declined",
          },
        },
      });
    const { wrapper } = createQueryClientTestHarness();
    render(<UsagePrivacyControls disabled={false} />, { wrapper });

    const control = await screen.findByRole("switch", {
      name: "Product analytics for this client",
    });

    fireEvent.click(control);
    await waitFor(() => expect(readClientUsageConsent().active).toBe(proof));
    expect(sdk.system.experimental_usageConsent).toHaveBeenNthCalledWith(1, {
      purpose: "product",
      choice: "granted",
      source: "settings",
    });
    expect(
      screen
        .getByRole("switch", { name: "Weekly activity count" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(control);
    await waitFor(() =>
      expect(sdk.system.experimental_usageConsent).toHaveBeenCalledTimes(2),
    );
    expect(readClientUsageConsent()).toEqual({ active: null, proofs: [proof] });
    expect(sdk.system.experimental_usageConsent).toHaveBeenNthCalledWith(2, {
      purpose: "product",
      choice: "declined",
      source: "settings",
      proof,
    });
  });
});
