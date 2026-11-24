import { describe, expect, it, vi } from "vitest";
import { Scope, type Envelope } from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";

describe("crash reports switch across bundled copies", () => {
  it("follows a switch set by another bundled copy of the module", async () => {
    const bootstrap = await import("../src/error-reporting.js");
    vi.resetModules();
    const daemon = await import("../src/error-reporting.js");

    expect(daemon).not.toBe(bootstrap);

    const envelopes: Envelope[] = [];

    const options = bootstrap.createProcessErrorReportingOptions(
      {
        dsn: "https://public@sentry.example.invalid/1",
        homeDir: "/home/omnyo-tester",
        nodeEnv: "production",
        release: "1.0.45",
        service: "host-daemon",
      },
      () => ({
        send: async (envelope) => {
          envelopes.push(envelope);

          return {};
        },
        flush: async () => true,
      }),
    );

    const client = new ServerRuntimeClient(options);
    client.init();
    const scope = new Scope();
    scope.setClient(client);

    try {
      daemon.setProcessErrorReportingEnabled(false);
      scope.captureException(new Error("disabled probe"));
      await client.flush(1000);
      expect(envelopes).toHaveLength(0);

      daemon.setProcessErrorReportingEnabled(true);
      scope.captureException(new Error("enabled probe"));
      await client.flush(1000);
      expect(envelopes).toHaveLength(1);
    } finally {
      bootstrap.setProcessErrorReportingEnabled(true);
      daemon.setProcessErrorReportingEnabled(true);
    }
  });
});
