import { describe, expect, it, vi } from "vitest";
import { createTelemetryService } from "../../src/services/system/telemetry.js";
import { getAppSettings, readUsageActors } from "@omnyo/db";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function post(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/system/telemetry/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("client telemetry events", () => {
  it("forwards an accepted onboarding event to telemetry unchanged", async () => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn<TelemetryService["capture"]>();
      harness.deps.telemetry = { ...harness.deps.telemetry, capture };

      const events = [
        {
          name: "onboarding_step_skipped",
          properties: { step: "projects", entry: "first_run" },
        },
        {
          name: "onboarding_step_completed",
          properties: { step: "browser", entry: "first_run" },
        },
        {
          name: "onboarding_agent_state",
          properties: {
            entry: "first_run",
            agent_installed: true,
            agent_ready: false,
          },
        },
        {
          name: "onboarding_agent_state",
          properties: {
            entry: "replay",
            agent_installed: null,
            agent_ready: null,
          },
        },
        {
          name: "onboarding_sign_in",
          properties: { entry: "first_run", outcome: "failed" },
        },
        {
          name: "new_thread_submit",
          properties: { outcome: "failed" },
        },
      ];

      for (const event of events) {
        capture.mockClear();
        const response = await post(harness, event);
        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ ok: true });
        expect(capture).toHaveBeenCalledExactlyOnceWith(event);
      }
    });
  });

  it("rejects unknown events and identifying extra properties", async () => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn<TelemetryService["capture"]>();
      harness.deps.telemetry = { ...harness.deps.telemetry, capture };

      const unknown = await post(harness, {
        name: "thread_created",
        properties: { is_child_thread: false, provider: "codex" },
      });

      const extra = await post(harness, {
        name: "onboarding_step_reached",
        properties: { step: "agent", entry: "first_run", threadId: "thr_123" },
      });

      expect(unknown.status).toBe(400);
      expect(extra.status).toBe(400);

      for (const event of [
        {
          name: "onboarding_agent_state",
          properties: {
            entry: "first_run",
            agent_installed: "account@example.com",
            agent_ready: false,
          },
        },
        {
          name: "onboarding_sign_in",
          properties: { entry: "first_run", outcome: "account@example.com" },
        },
        {
          name: "new_thread_submit",
          properties: { outcome: "failed", message: "private prompt" },
        },
      ]) {
        expect((await post(harness, event)).status).toBe(400);
      }

      expect(capture).not.toHaveBeenCalled();
    });
  });
  it("uses normal consent and event routes to exclude a second client and preserves independent choices", async () => {
    await withTestHarness(async (harness) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));

      vi.stubGlobal("fetch", fetchMock);

      try {
        harness.deps.telemetry = await createTelemetryService({
          db: harness.db,
          dataDir: harness.config.dataDir,
          appVersion: "1.2.3",
          enabled: true,
          collectorUrl: "http://127.0.0.1:12345",
          logger: harness.deps.logger,
        });

        const choose = async (body: object) => {
          const response = await harness.app.request(
            "/api/v1/system/usage/consent",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );

          expect(response.status).toBe(200);

          return response.json();
        };

        const granted = await choose({
          purpose: "product",
          choice: "granted",
          source: "sdk",
        });

        expect(typeof granted.proof).toBe("string");

        const send = (proof?: string) =>
          harness.app.request("/api/v1/system/telemetry/events", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-omnyo-user-activity": "1",
              ...(proof ? { "x-omnyo-analytics-consent": proof } : {}),
            },
            body: JSON.stringify({
              name: "onboarding_step_completed",
              properties: { step: "projects", entry: "first_run" },
            }),
          });

        await send();
        expect(fetchMock).not.toHaveBeenCalled();
        await send(granted.proof);
        expect(fetchMock).not.toHaveBeenCalled();
        const now = Date.now();

        const clock = vi
          .spyOn(Date, "now")
          .mockReturnValue(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);

        harness.deps.telemetry.prune();
        clock.mockRestore();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await choose({ purpose: "count", choice: "declined", source: "sdk" });
        expect(
          harness.deps.telemetry.status(granted.proof).product.effective,
        ).toBe(true);
        const { usageConsent, ...legacySettings } = getAppSettings(harness.db);

        const updated = await harness.app.request("/api/v1/settings/general", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...legacySettings, showKeyboardHints: false }),
        });

        expect(updated.status).toBe(200);
        expect(getAppSettings(harness.db).usageConsent).toEqual(usageConsent);
        expect(
          harness.deps.telemetry.status(granted.proof).product.effective,
        ).toBe(true);
        await choose({
          purpose: "product",
          choice: "declined",
          source: "sdk",
          proof: granted.proof,
        });
        await send(granted.proof);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const invalid = await harness.app.request(
          "/api/v1/system/usage/consent",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              purpose: "product",
              choice: "granted",
              source: "sdk",
              extra: "private",
            }),
          },
        );

        expect(invalid.status).toBe(400);
        expect(readUsageActors(harness.db)[0]?.keys).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
