import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECT_APEX_URL,
  connectDashboardUrl,
  parseConnectPairingPayload,
  resolveEnrollmentTarget,
} from "./connect-payload";

function serverUrlForDefaultApex(handle: string): string {
  const apex = new URL(DEFAULT_CONNECT_APEX_URL);

  return `${apex.protocol}//${handle}.${apex.host}`;
}

describe("parseConnectPairingPayload", () => {
  it("reads the web/CLI JSON payload, normalizing the code and validating URLs", () => {
    expect(
      parseConnectPairingPayload(
        JSON.stringify({
          code: " abcd-efgh ",
          serverUrl: "https://bee.example.test/",
          apex: "https://example.test",
          expiresAt: "2026-08-19T10:00:00Z",
        }),
      ),
    ).toEqual({
      code: "ABCD-EFGH",
      serverUrl: "https://bee.example.test",
      apexUrl: "https://example.test",
      expiresAt: Date.UTC(2026, 7, 19, 10),
    });
    expect(
      parseConnectPairingPayload(
        '{"code":"ABCD-EFGH","serverUrl":"not a url","expiresAt":1700000000000}',
      ),
    ).toEqual({
      code: "ABCD-EFGH",
      serverUrl: null,
      apexUrl: null,
      expiresAt: 1700000000000,
    });
    expect(parseConnectPairingPayload('{"serverUrl":"https://x.y"}')).toBe(
      null,
    );
    expect(parseConnectPairingPayload("{not json")).toBe(null);
  });

  it("reads a pairing URL and a bare code; rejects arbitrary QR contents", () => {
    expect(
      parseConnectPairingPayload(
        "omnyo://connect?code=abcd-efgh&serverUrl=https%3A%2F%2Fbee.example.test",
      ),
    ).toEqual({
      code: "ABCD-EFGH",
      serverUrl: "https://bee.example.test",
      apexUrl: null,
      expiresAt: null,
    });
    expect(parseConnectPairingPayload("  abcd-efgh\n")).toEqual({
      code: "ABCD-EFGH",
      serverUrl: null,
      apexUrl: null,
      expiresAt: null,
    });
    expect(parseConnectPairingPayload("https://example.com/menu")).toBe(null);
    expect(parseConnectPairingPayload("hello world")).toBe(null);
    expect(parseConnectPairingPayload("")).toBe(null);
  });
});

describe("resolveEnrollmentTarget", () => {
  it("derives the apex from a handle, a server URL, or an explicit override", () => {
    expect(
      resolveEnrollmentTarget({
        code: "abcd-efgh",
        server: "bee",
        apexUrl: "",
      }),
    ).toEqual({
      ok: true,
      code: "ABCD-EFGH",
      apexUrl: DEFAULT_CONNECT_APEX_URL,
      serverUrl: serverUrlForDefaultApex("bee"),
    });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "https://stub.localhost:42998/",
        apexUrl: "",
      }),
    ).toEqual({
      ok: true,
      code: "ABCD-EFGH",
      apexUrl: "https://localhost:42998",
      serverUrl: "https://stub.localhost:42998",
    });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "bee",
        apexUrl: "https://stg.omnyo.link",
      }),
    ).toEqual({
      ok: true,
      code: "ABCD-EFGH",
      apexUrl: "https://stg.omnyo.link",
      serverUrl: "https://bee.stg.omnyo.link",
    });
    expect(
      resolveEnrollmentTarget({ code: "ABCD-EFGH", server: "", apexUrl: "" }),
    ).toEqual({
      ok: true,
      code: "ABCD-EFGH",
      apexUrl: DEFAULT_CONNECT_APEX_URL,
      serverUrl: null,
    });
  });

  it("reports the offending field", () => {
    expect(
      resolveEnrollmentTarget({ code: "  ", server: "bee", apexUrl: "" }),
    ).toMatchObject({ ok: false, field: "code" });
    expect(
      resolveEnrollmentTarget({ code: "ab", server: "bee", apexUrl: "" }),
    ).toMatchObject({ ok: false, field: "code" });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "bee server",
        apexUrl: "",
      }),
    ).toMatchObject({ ok: false, field: "server" });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "ftp://bee",
        apexUrl: "",
      }),
    ).toMatchObject({ ok: false, field: "server" });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "bee",
        apexUrl: "example.test",
      }),
    ).toMatchObject({ ok: false, field: "apexUrl" });
  });
});

describe("self-hosted relay pairing", () => {
  it("refuses the retired getbb.app relay and other apexes before redeeming a code", () => {
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "https://alex.getbb.app",
        apexUrl: "",
      }),
    ).toMatchObject({ ok: false, field: "server" });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "alexb",
        apexUrl: "https://connect.example.com",
      }),
    ).toMatchObject({ ok: false, field: "apexUrl" });
    expect(
      parseConnectPairingPayload(
        JSON.stringify({
          code: "ABCD-EFGH",
          serverUrl: "https://alex.getbb.app",
          apex: "https://getbb.app",
        }),
      ),
    ).toMatchObject({ apexUrl: "https://getbb.app" });
    expect(
      resolveEnrollmentTarget({
        code: "ABCD-EFGH",
        server: "https://alex.getbb.app",
        apexUrl: "https://getbb.app",
      }),
    ).toMatchObject({ ok: false, field: "apexUrl" });
  });

  it("defaults typed handles to the omnyo.link relay, not the retired getbb.app apex", () => {
    expect(DEFAULT_CONNECT_APEX_URL).toBe("https://omnyo.link");
    expect(
      resolveEnrollmentTarget({
        code: "abcd-efgh",
        server: "alexb",
        apexUrl: "",
      }),
    ).toEqual({
      ok: true,
      code: "ABCD-EFGH",
      apexUrl: "https://omnyo.link",
      serverUrl: "https://alexb.omnyo.link",
    });
  });

  it("reads the coordinator's relay QR payload and its omnyo:// link form", () => {
    const expected = {
      code: "ABCD-EFGH",
      serverUrl: "https://alexb.omnyo.link",
      apexUrl: "https://omnyo.link",
    };

    expect(
      parseConnectPairingPayload(
        JSON.stringify({
          code: "ABCD-EFGH",
          serverUrl: "https://alexb.omnyo.link",
          apex: "https://omnyo.link",
          expiresAt: 1_800_000_000_000,
        }),
      ),
    ).toEqual({ ...expected, expiresAt: 1_800_000_000_000 });
    expect(
      parseConnectPairingPayload(
        "omnyo://connect?code=ABCD-EFGH&serverUrl=https%3A%2F%2Falexb.omnyo.link&apex=https%3A%2F%2Fomnyo.link",
      ),
    ).toEqual({ ...expected, expiresAt: null });
  });
});

describe("connectDashboardUrl", () => {
  it("opens the dashboard on the relay that serves the server", () => {
    expect(connectDashboardUrl("https://alexb.omnyo.link")).toBe(
      "https://omnyo.link/dashboard",
    );
    expect(connectDashboardUrl("https://alexb.stg.omnyo.link")).toBe(
      "https://stg.omnyo.link/dashboard",
    );
  });

  it("never links a retired relay's dashboard", () => {
    expect(connectDashboardUrl("https://alex.getbb.app")).toBe(
      `${DEFAULT_CONNECT_APEX_URL}/dashboard`,
    );
  });
});
