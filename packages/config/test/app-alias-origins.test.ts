import { describe, expect, it } from "vitest";
import { parseAppManagedConfig } from "../src/managed-app-config.js";
import { parseAppAliasOrigins } from "../src/public-url.js";
import { loadServerConfig } from "../src/server.js";

function serverEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    OMNYO_DATA_DIR: "/tmp/omnyo-alias-data",
    OMNYO_HOST_DAEMON_PORT: "5555",
    OMNYO_SERVER_PORT: "4444",
    NODE_ENV: "production",
    ...overrides,
  };
}

describe("OMNYO_APP_ALIAS_URLS", () => {
  it("normalises a comma-separated list to unique https origins", () => {
    expect(
      parseAppAliasOrigins(
        "OMNYO_APP_ALIAS_URLS",
        " https://App.Omnyo.example/ , https://app.omnyo.example,https://alt.example:8443 ",
      ),
    ).toEqual(["https://app.omnyo.example", "https://alt.example:8443"]);
    expect(parseAppAliasOrigins("OMNYO_APP_ALIAS_URLS", "  ")).toEqual([]);
  });

  it.each([
    ["http://app.omnyo.example", /does not use https/u],
    ["https://app.omnyo.example/path", /path, query or fragment/u],
    ["https://app.omnyo.example?x=1", /path, query or fragment/u],
    ["https://app.omnyo.example#x", /path, query or fragment/u],
    ["https://user:pass@app.omnyo.example", /credentials/u],
    ["https://*.omnyo.example", /wildcard/u],
    ["app.omnyo.example", /not a valid URL/u],
    ["https://app.omnyo.example,,https://b.example", /is empty/u],
  ])("rejects %s", (value, expected) => {
    expect(() => parseAppAliasOrigins("OMNYO_APP_ALIAS_URLS", value)).toThrow(
      expected,
    );
  });

  it("is read from the server environment beside OMNYO_APP_URL", () => {
    const config = loadServerConfig({
      env: serverEnv({
        OMNYO_APP_URL: "https://omnyo.example.test",
        OMNYO_APP_ALIAS_URLS: "https://app.omnyo.example/",
      }),
    });

    expect(config.OMNYO_APP_URL).toBe("https://omnyo.example.test");
    expect(config.OMNYO_APP_ALIAS_URLS).toEqual(["https://app.omnyo.example"]);
    expect(
      loadServerConfig({ env: serverEnv({}) }).OMNYO_APP_ALIAS_URLS,
    ).toEqual([]);
    expect(() =>
      loadServerConfig({
        env: serverEnv({ OMNYO_APP_ALIAS_URLS: "http://app.omnyo.example" }),
      }),
    ).toThrow(/OMNYO_APP_ALIAS_URLS/u);
  });

  it("is accepted as a managed config key", () => {
    expect(
      parseAppManagedConfig({
        config: {
          OMNYO_APP_URL: "https://omnyo.example.test",
          OMNYO_APP_ALIAS_URLS: "https://app.omnyo.example",
        },
      }).config,
    ).toEqual({
      OMNYO_APP_URL: "https://omnyo.example.test",
      OMNYO_APP_ALIAS_URLS: "https://app.omnyo.example",
    });
  });
});
