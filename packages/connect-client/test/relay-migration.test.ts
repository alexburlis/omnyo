import { describe, expect, it } from "vitest";
import {
  migrateLegacyPrivateServerUrl,
  migrateLegacyRelayApexUrl,
  migrateLegacyRelayServerUrl,
} from "../src/relay-migration.js";

describe("private coordinator address migration", () => {
  it("preserves the request path and query on the same private gateway", () => {
    expect(migrateLegacyPrivateServerUrl("https://app.example.invalid")).toBe(
      "https://app.example.invalid",
    );
    expect(
      migrateLegacyPrivateServerUrl(
        "https://app.example.invalid/private-updates/latest/macos/?v=1#release",
      ),
    ).toBe("https://app.example.invalid/private-updates/latest/macos/?v=1#release");
  });

  it.each([
    "https://app.example.invalid",
    "https://alexb.omnyo.link",
    "https://app.example.invalid.example",
    "https://app.example.invalid:9443",
    "https://user@app.example.invalid",
    "http://app.example.invalid",
  ])("leaves other addresses alone (%s)", (value) => {
    expect(migrateLegacyPrivateServerUrl(value)).toBeNull();
  });
});

describe("retired relay address migration", () => {
  it("maps only production and staging tenant addresses and preserves their routes", () => {
    expect(migrateLegacyRelayServerUrl("https://owner-relay.example.invalid")).toBe(
      "https://alexb.omnyo.link",
    );
    expect(
      migrateLegacyRelayServerUrl(
        "https://second.stg.slashnew.com/path?q=1#draft",
      ),
    ).toBe("https://second.stg.omnyo.link/path?q=1#draft");
    expect(migrateLegacyRelayApexUrl("https://slashnew.com/")).toBe(
      "https://omnyo.link",
    );
    expect(migrateLegacyRelayApexUrl("https://stg.slashnew.com")).toBe(
      "https://stg.omnyo.link",
    );
  });

  it.each([
    "https://slashnew.com",
    "https://stg.slashnew.com",
    "https://a.b.slashnew.com",
    "https://owner-relay.example.invalid.attacker.test",
    "https://owner-relay.example.invalid@attacker.test",
    "https://user@owner-relay.example.invalid",
    "https://owner-relay.example.invalid:8443",
    "http://owner-relay.example.invalid",
    "https://alexb.omnyo.link",
    "http://localhost:1234",
    "https://-invalid.slashnew.com",
    "https://custom.example",
    "not a URL",
  ])("does not migrate unrelated or unsafe input %s", (url) => {
    expect(migrateLegacyRelayServerUrl(url)).toBeNull();
  });

  it.each([
    "https://slashnew.com/path",
    "https://slashnew.com?redirect=1",
    "https://user@slashnew.com",
    "https://slashnew.com:8443",
    "http://slashnew.com",
    "https://slashnew.com.attacker.test",
  ])("does not accept an unsafe apex %s", (url) => {
    expect(migrateLegacyRelayApexUrl(url)).toBeNull();
  });
});
