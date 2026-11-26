import { describe, expect, it } from "vitest";
import { resolveShellIncomingLink } from "./shell-links";

const profiles = [
  { id: "p_bee", serverUrl: "https://bee.example.test" },
  { id: "p_lan", serverUrl: "http://10.0.0.7:38886" },
  { id: "p_prefix", serverUrl: "https://box.example.ts.net/omnyo" },
];

const context = {
  profiles,
  activeProfileId: "p_bee",
  developerRoutesEnabled: false,
};

describe("resolveShellIncomingLink", () => {
  it.each([
    ["omnyo://settings/device", "/settings/device"],
    ["omnyo://settings/notifications", "/settings/notifications"],
    ["omnyo://settings/general", "/webview?path=%2Fsettings%2Fgeneral"],
    ["omnyo://connections", "/webview?path=%2Fconnections"],
    ["omnyo://", "/webview?path=%2F"],
    ["omnyo://threads/thr_1", "/webview?path=%2Fthreads%2Fthr_1"],
    ["omnyo://connect?code=ABCD-EFGH", "/connect?code=ABCD-EFGH"],
    ["omnyo://settings/servers", "/settings/servers"],
    ["omnyo://settings/servers/add", "/settings/servers/add"],
    ["omnyo://settings/machines", "/webview?path=%2Fsettings%2Fmachines"],
    ["omnyo://settings", "/webview?path=%2Fsettings"],
  ])("routes the scheme link %s to %s", (url, path) => {
    expect(resolveShellIncomingLink(url, context)).toEqual({
      kind: "navigate",
      path,
      profileId: null,
    });
  });

  it("hides developer routes in a release bundle", () => {
    expect(
      resolveShellIncomingLink("omnyo://dev/webview-spike", context),
    ).toEqual({ kind: "navigate", path: "/", profileId: null });
    expect(
      resolveShellIncomingLink("omnyo://dev/webview-spike", {
        ...context,
        developerRoutesEnabled: true,
      }),
    ).toEqual({
      kind: "navigate",
      path: "/dev/webview-spike",
      profileId: null,
    });
  });

  it("opens a web link on the profile that owns it", () => {
    expect(
      resolveShellIncomingLink(
        "https://bee.example.test/threads/x?a=1",
        context,
      ),
    ).toEqual({
      kind: "navigate",
      path: "/webview?path=%2Fthreads%2Fx%3Fa%3D1",
      profileId: null,
    });
  });

  it("names the profile when a link switches servers", () => {
    const resolution = resolveShellIncomingLink(
      "http://10.0.0.7:38886/threads/x",
      context,
    );

    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_lan&path=%2Fthreads%2Fx",
      profileId: "p_lan",
    });
  });

  it("keeps an explicit root path when a link switches servers", () => {
    expect(resolveShellIncomingLink("http://10.0.0.7:38886/", context)).toEqual(
      {
        kind: "navigate",
        path: "/webview?profileId=p_lan&path=%2F",
        profileId: "p_lan",
      },
    );
  });

  it("keeps an explicit root path when a warm web link stays on the current server", () => {
    expect(
      resolveShellIncomingLink("https://bee.example.test/", context),
    ).toEqual({
      kind: "navigate",
      path: "/webview?path=%2F",
      profileId: null,
    });
  });

  it("strips a profile's mount prefix from the page path", () => {
    const resolution = resolveShellIncomingLink(
      "https://box.example.ts.net/omnyo/threads/x",
      context,
    );

    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_prefix&path=%2Fthreads%2Fx",
      profileId: "p_prefix",
    });
  });

  it("offers to add a server the phone does not know", () => {
    const resolution = resolveShellIncomingLink(
      "https://other.example.test/threads/x",
      context,
    );

    expect(resolution.kind).toBe("unknown-server");

    if (resolution.kind !== "unknown-server") throw new Error("unreachable");
    expect(resolution.serverUrl).toBe("https://other.example.test");
    expect(resolution.path).toBe("/webview?path=%2Fthreads%2Fx");
  });

  it("leaves a foreign scheme alone", () => {
    expect(
      resolveShellIncomingLink("exp+bb-app://expo-development-client", context),
    ).toEqual({ kind: "passthrough" });
    expect(resolveShellIncomingLink("bb://threads/thr_1", context)).toEqual({
      kind: "passthrough",
    });
  });
});

describe("workflow import links", () => {
  const shareId = "a".repeat(32);
  it.each([`omnyo://workflows/import/${shareId}`])(
    "requires a recipient server choice for %s",
    (url) => {
      expect(resolveShellIncomingLink(url, context)).toEqual({
        kind: "navigate",
        path: `/workflows/import?shareId=${shareId}`,
        profileId: null,
      });
      expect(
        resolveShellIncomingLink(url, {
          ...context,
          profiles: [],
          activeProfileId: null,
        }),
      ).toEqual({
        kind: "navigate",
        path: `/workflows/import?shareId=${shareId}`,
        profileId: null,
      });
    },
  );
  it("leaves the public HTTPS landing in the browser", () => {
    expect(
      resolveShellIncomingLink(`https://omnyohq.com/w/${shareId}`, context),
    ).toEqual({ kind: "passthrough" });
  });
  it.each([
    "omnyo://workflows/import/../secrets",
    `omnyo://workflows/import/${shareId}?server=https://attacker.invalid`,
  ])("does not forward destination injection %s", (url) => {
    expect(resolveShellIncomingLink(url, context)).toEqual({
      kind: "navigate",
      path: "/workflows/import",
      profileId: null,
    });
  });
});
