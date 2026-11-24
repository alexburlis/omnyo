import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addServerPathForLink,
  isDeveloperRoutePath,
  matchProfileForWebLink,
  OMNYO_URL_SCHEMES,
  parseIncomingLink,
} from "./incoming-link";

const requireFromTest = createRequire(import.meta.url);

const sawyer = { id: "p1", serverUrl: "https://sawyer.example.test" };

const lan = { id: "p2", serverUrl: "http://192.168.1.20:3000" };

const prefixed = { id: "p3", serverUrl: "https://home.example.com/omnyo" };

describe("parseIncomingLink", () => {
  it("treats the first segment of an omnyo:// link as a path segment, not a host", () => {
    expect(parseIncomingLink("omnyo://threads/thr_1?x=1#frag")).toEqual({
      kind: "scheme",
      path: "/threads/thr_1?x=1",
    });
    expect(parseIncomingLink("omnyo:///settings/servers/")).toEqual({
      kind: "scheme",
      path: "/settings/servers",
    });
    expect(parseIncomingLink("omnyo://")).toEqual({
      kind: "scheme",
      path: "/",
    });
    expect(parseIncomingLink("OMNYO://e2e/reset")).toEqual({
      kind: "scheme",
      path: "/e2e/reset",
    });
  });

  it("parses web links into origin + path + search", () => {
    expect(
      parseIncomingLink("https://sawyer.example.test/threads/thr_1/?view=full"),
    ).toEqual({
      kind: "web",
      origin: "https://sawyer.example.test",
      pathname: "/threads/thr_1",
      search: "?view=full",
    });
  });

  it("leaves dev-client and other schemes alone", () => {
    expect(
      parseIncomingLink(
        "exp+bb-app://expo-development-client/?url=http://127.0.0.1:8082",
      ),
    ).toEqual({ kind: "foreign" });
    expect(
      parseIncomingLink(
        "exp+omnyo-private://expo-development-client/?url=http://127.0.0.1:8082",
      ),
    ).toEqual({ kind: "foreign" });
    expect(parseIncomingLink("omnyox://threads")).toEqual({ kind: "foreign" });
    expect(parseIncomingLink("bb://threads/thr_1")).toEqual({
      kind: "foreign",
    });
    expect(parseIncomingLink("mailto:x@y.z")).toEqual({ kind: "foreign" });
    expect(parseIncomingLink("")).toEqual({ kind: "foreign" });
  });
});

describe("registered app schemes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function registeredScheme(env: Record<string, string>): unknown {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const { expo } = requireFromTest("../../../app.json") as {
      expo: Record<string, unknown>;
    };

    const appConfig = requireFromTest("../../../app.config.js") as (input: {
      config: Record<string, unknown>;
    }) => { scheme: unknown };

    return appConfig({ config: structuredClone(expo) }).scheme;
  }

  it.each([
    [{ OMNYO_MOBILE_VARIANT: "production" }, "omnyo"],
    [{ OMNYO_MOBILE_VARIANT: "dev" }, "omnyo"],
    [
      {
        OMNYO_MOBILE_VARIANT: "private",
        OMNYO_PRIVATE_IOS_VERSION: "1.0.0",
        OMNYO_PRIVATE_IOS_BUILD: "1",
      },
      "omnyo",
    ],
  ])("accepts the scheme that build %o registers", (env, scheme) => {
    expect(registeredScheme(env)).toBe(scheme);
    expect(OMNYO_URL_SCHEMES).toEqual([scheme]);
    expect(parseIncomingLink(`${scheme}://threads/thr_1`)).toEqual({
      kind: "scheme",
      path: "/threads/thr_1",
    });
  });
});

describe("matchProfileForWebLink", () => {
  it("matches by origin, ignoring scheme/port differences", () => {
    const profiles = [sawyer, lan];
    expect(
      matchProfileForWebLink(
        profiles,
        "https://sawyer.example.test",
        "/threads/x",
      )?.profile,
    ).toBe(sawyer);
    expect(
      matchProfileForWebLink(
        profiles,
        "http://sawyer.example.test",
        "/threads/x",
      ),
    ).toBeNull();
    expect(
      matchProfileForWebLink(profiles, "http://192.168.1.20:3000", "/")
        ?.profile,
    ).toBe(lan);
    expect(
      matchProfileForWebLink(profiles, "http://192.168.1.20:3001", "/"),
    ).toBeNull();
  });

  it("strips a profile path prefix and refuses paths outside it", () => {
    const match = matchProfileForWebLink(
      [prefixed],
      "https://home.example.com",
      "/omnyo/threads/thr_9",
    );

    expect(match).toEqual({ profile: prefixed, pathname: "/threads/thr_9" });
    expect(
      matchProfileForWebLink([prefixed], "https://home.example.com", "/omnyo"),
    ).toEqual({ profile: prefixed, pathname: "/" });
    expect(
      matchProfileForWebLink(
        [prefixed],
        "https://home.example.com",
        "/omnyox/threads/thr_9",
      ),
    ).toBeNull();
  });
});

describe("isDeveloperRoutePath", () => {
  it("recognises the route groups a release bundle does not ship", () => {
    expect(isDeveloperRoutePath("/dev/webview-spike")).toBe(true);
    expect(isDeveloperRoutePath("/e2e/reset?wipe=1")).toBe(true);
    expect(isDeveloperRoutePath("/webview")).toBe(false);
    expect(isDeveloperRoutePath("/development")).toBe(false);
  });
});

describe("addServerPathForLink", () => {
  it("prefills the add-server screen and remembers where to go next", () => {
    expect(
      addServerPathForLink(
        "https://bee.example.test",
        "/webview?path=%2Fthreads",
      ),
    ).toBe(
      "/settings/servers/add?serverUrl=https%3A%2F%2Fbee.example.test&next=%2Fwebview%3Fpath%3D%252Fthreads",
    );
  });

  it("omits a follow-up path that is just the root", () => {
    expect(addServerPathForLink("https://bee.example.test", "/")).toBe(
      "/settings/servers/add?serverUrl=https%3A%2F%2Fbee.example.test",
    );
  });
});
