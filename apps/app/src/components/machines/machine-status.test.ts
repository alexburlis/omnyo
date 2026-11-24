import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  machinePhaseLabel,
  machineStatusLabel,
  machineStatusTone,
} from "./machine-status";

describe("resuming machine status", () => {
  const host = makeHost({
    status: "connected",
    lifecycle: {
      phase: "resuming",
      suspendedAt: 1,
      message: "Restoring compute",
      pendingLog: "",
      teardown: null,
    },
  });

  it("keeps lifecycle status ahead of the transport connection", () => {
    expect(machinePhaseLabel(host.lifecycle)).toBe("Resuming");
    expect(machineStatusLabel({ host, now: 2 })).toBe(
      "Resuming · Restoring compute",
    );
    expect(machineStatusTone(host)).toBe("attention");
  });
});

it("distinguishes a rejected worker protocol from a network-offline machine", () => {
  const rejected = makeHost({
    status: "disconnected",
    lastRejectedProtocolVersion: 238,
    lastSeenAt: null,
  });

  expect(machineStatusLabel({ host: rejected, now: 1 })).toBe("Needs update");
  expect(machineStatusTone(rejected)).toBe("attention");

  const offline = makeHost({
    status: "disconnected",
    lastRejectedProtocolVersion: null,
    lastSeenAt: null,
  });

  expect(machineStatusLabel({ host: offline, now: 1 })).toBe("Offline");
  expect(machineStatusTone(offline)).toBe("offline");
});
