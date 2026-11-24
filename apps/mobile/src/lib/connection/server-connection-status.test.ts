import { describe, expect, it } from "vitest";
import { describeServerConnection } from "./server-connection-status";

const profile = { id: "p_bee" };

describe("describeServerConnection", () => {
  it("reports the live socket once the session allows it", () => {
    expect(
      describeServerConnection({
        profileId: "p_bee",
        connection: { profile, client: {}, session: { status: "idle" } },
        realtime: "connected",
      }),
    ).toBe("Connected");
    expect(
      describeServerConnection({
        profileId: "p_bee",
        connection: {
          profile,
          client: {},
          session: { status: "authenticated" },
        },
        realtime: "reconnecting",
      }),
    ).toBe("Reconnecting");
  });

  it("puts a session problem ahead of the socket state", () => {
    expect(
      describeServerConnection({
        profileId: "p_bee",
        connection: {
          profile,
          client: {},
          session: { status: "auth-required" },
        },
        realtime: "connected",
      }),
    ).toBe("Sign in again");
    expect(
      describeServerConnection({
        profileId: "p_bee",
        connection: { profile, client: {}, session: { status: "error" } },
        realtime: "connecting",
      }),
    ).toBe("Can't sign in");
  });

  it("asks to pair again when the server's relay is retired", () => {
    expect(
      describeServerConnection({
        profileId: "p_bee",
        connection: {
          profile,
          client: null,
          session: { status: "unsupported" },
        },
        realtime: "connecting",
      }),
    ).toBe("Pair again");
  });

  it("does not report another profile's connection", () => {
    expect(
      describeServerConnection({
        profileId: "p_lan",
        connection: { profile, client: {}, session: { status: "idle" } },
        realtime: "connected",
      }),
    ).toBe("Connecting");
  });
});
