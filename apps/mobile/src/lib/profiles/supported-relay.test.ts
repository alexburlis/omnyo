import { describe, expect, it } from "vitest";
import {
  isSupportedRelayApex,
  isSupportedRelayServer,
} from "./supported-relay";

describe("supported relay", () => {
  it("accepts the omnyo.link relay, its staging apex and the local connect stub", () => {
    expect(isSupportedRelayApex("https://omnyo.link")).toBe(true);
    expect(isSupportedRelayApex("https://stg.omnyo.link")).toBe(true);
    expect(isSupportedRelayApex("https://localhost:42998")).toBe(true);
    expect(isSupportedRelayServer("https://alexb.omnyo.link")).toBe(true);
    expect(isSupportedRelayServer("https://alexb.stg.omnyo.link")).toBe(true);
    expect(isSupportedRelayServer("https://stub.localhost:42998")).toBe(true);
  });

  it("refuses the retired getbb.app relay and every other apex", () => {
    expect(isSupportedRelayApex("https://getbb.app")).toBe(false);
    expect(isSupportedRelayServer("https://alex.getbb.app")).toBe(false);
    expect(isSupportedRelayApex("http://omnyo.link")).toBe(false);
    expect(isSupportedRelayApex("https://omnyo.link:8443")).toBe(false);
    expect(isSupportedRelayApex("https://omnyo.link.example.com")).toBe(false);
    expect(isSupportedRelayApex("https://connect.example.com")).toBe(false);
    expect(isSupportedRelayServer("https://omnyo.link")).toBe(false);
    expect(isSupportedRelayServer("not a url")).toBe(false);
  });
});

it.each([
  "https://app.omnyo.link",
  "https://alice.slashnew.com",
  "https://alice.stg.slashnew.com",
  "https://user@alice.omnyo.link",
  "https://alice.omnyo.link:8443",
  "https://alice.omnyo.link.attacker.test",
  "https://alice.extra.omnyo.link",
])("refuses retired and misleading pairing origins %s", (url) => {
  expect(isSupportedRelayServer(url)).toBe(false);
});
