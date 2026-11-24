import { describe, expect, it } from "vitest";
import {
  buildHostDaemonWebSocketProtocols,
  hasHostDaemonWebSocketProtocol,
} from "../src/index.js";

describe("host daemon websocket subprotocol transition", () => {
  it("offers the canonical name first and keeps the legacy name for older servers", () => {
    expect(buildHostDaemonWebSocketProtocols()).toEqual([
      "omnyo-host-daemon.v1",
      "bb-host-daemon.v1",
    ]);
  });

  it.each([
    ["an older daemon", "bb-host-daemon.v1"],
    ["a canonical-only daemon", "omnyo-host-daemon.v1"],
    ["a current daemon", "omnyo-host-daemon.v1, bb-host-daemon.v1"],
  ])("accepts %s", (_label, header) => {
    expect(hasHostDaemonWebSocketProtocol(header)).toBe(true);
  });

  it.each([undefined, "", "other-protocol", "bb-host-daemon.v2"])(
    "refuses %s",
    (header) => {
      expect(hasHostDaemonWebSocketProtocol(header)).toBe(false);
    },
  );
});
