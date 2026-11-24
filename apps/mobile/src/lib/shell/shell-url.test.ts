import { describe, expect, it } from "vitest";
import {
  buildShellUrl,
  decideShellNavigation,
  isExternallyOpenable,
  isRelaySignInRedirect,
  isShellNavigation,
  SHELL_ORIGIN_WHITELIST,
  shellPathFromUrl,
} from "./shell-url";

const ROOT = "https://bee.example.test";

const PREFIXED = "https://box.example.ts.net/omnyo";

describe("buildShellUrl", () => {
  it("joins a page path onto a server mounted at the root", () => {
    expect(buildShellUrl(ROOT, "/")).toBe("https://bee.example.test/");
    expect(buildShellUrl(`${ROOT}/`, "/threads/thr_1")).toBe(
      "https://bee.example.test/threads/thr_1",
    );
    expect(buildShellUrl(ROOT, "/threads/thr_1?tab=diff")).toBe(
      "https://bee.example.test/threads/thr_1?tab=diff",
    );
  });

  it("keeps a server's path prefix", () => {
    expect(buildShellUrl(PREFIXED, "/")).toBe(
      "https://box.example.ts.net/omnyo/",
    );
    expect(buildShellUrl(PREFIXED, "/threads/thr_1")).toBe(
      "https://box.example.ts.net/omnyo/threads/thr_1",
    );
  });

  it("tolerates a path with no leading slash", () => {
    expect(buildShellUrl(ROOT, "threads/thr_1")).toBe(
      "https://bee.example.test/threads/thr_1",
    );
  });
});

describe("isShellNavigation", () => {
  it("keeps the profile's own pages in the WebView", () => {
    expect(isShellNavigation("https://bee.example.test/threads/x", ROOT)).toBe(
      true,
    );
    expect(isShellNavigation("https://bee.example.test/", ROOT)).toBe(true);
  });

  it("sends another origin to the system browser", () => {
    expect(isShellNavigation("https://example.com/docs", ROOT)).toBe(false);
    expect(isShellNavigation("https://other.example.test/", ROOT)).toBe(false);
    expect(isShellNavigation("http://bee.example.test/", ROOT)).toBe(false);
  });

  it("does not let a sibling path escape a prefixed mount", () => {
    expect(
      isShellNavigation("https://box.example.ts.net/omnyo/x", PREFIXED),
    ).toBe(true);
    expect(
      isShellNavigation("https://box.example.ts.net/omnyoadmin", PREFIXED),
    ).toBe(false);
    expect(
      isShellNavigation("https://box.example.ts.net/other", PREFIXED),
    ).toBe(false);
  });

  it("refuses a URL that will not parse", () => {
    expect(isShellNavigation("not a url", ROOT)).toBe(false);
    expect(isShellNavigation("https://bee.example.test/", "not a url")).toBe(
      false,
    );
  });
});

describe("shellPathFromUrl", () => {
  it("returns the page path, minus any mount prefix", () => {
    expect(
      shellPathFromUrl("https://bee.example.test/threads/x?a=1", ROOT),
    ).toBe("/threads/x?a=1");
    expect(shellPathFromUrl("https://bee.example.test/", ROOT)).toBe("/");
    expect(
      shellPathFromUrl("https://box.example.ts.net/omnyo/threads/x", PREFIXED),
    ).toBe("/threads/x");
    expect(shellPathFromUrl("https://box.example.ts.net/omnyo", PREFIXED)).toBe(
      "/",
    );
  });

  it("returns null for a URL outside the profile", () => {
    expect(shellPathFromUrl("https://example.com/x", ROOT)).toBeNull();
  });
});

describe("isExternallyOpenable", () => {
  it("allows only the schemes a system browser should receive", () => {
    expect(isExternallyOpenable("https://example.com")).toBe(true);
    expect(isExternallyOpenable("http://10.0.0.2:1234/x")).toBe(true);
    expect(isExternallyOpenable("mailto:a@b.com")).toBe(true);

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "about:blank",
      "tel:+1234",
      "",
    ]) {
      expect(isExternallyOpenable(url), url).toBe(false);
    }
  });
});

describe("isRelaySignInRedirect", () => {
  const RELAY = "https://alexb.omnyo.link";

  const authorize = (host: string, origin = "https://omnyo.link") =>
    `${origin}/relay/authorize?host=${host}&return=%2Fthreads%2Fthr_1&n=nonce`;

  it("recognizes the relay's sign-in redirect for this server", () => {
    expect(isRelaySignInRedirect(authorize("alexb.omnyo.link"), RELAY)).toBe(
      true,
    );
    expect(isShellNavigation(authorize("alexb.omnyo.link"), RELAY)).toBe(false);
  });

  it("ignores another server's redirect, another apex and other relay pages", () => {
    expect(isRelaySignInRedirect(authorize("bob.omnyo.link"), RELAY)).toBe(
      false,
    );
    expect(
      isRelaySignInRedirect(
        authorize("alexb.omnyo.link", "https://evil.example"),
        RELAY,
      ),
    ).toBe(false);
    expect(
      isRelaySignInRedirect(
        "https://omnyo.link/dashboard?host=alexb.omnyo.link",
        RELAY,
      ),
    ).toBe(false);
    expect(
      isRelaySignInRedirect(
        `${RELAY}/relay/authorize?host=alexb.omnyo.link`,
        RELAY,
      ),
    ).toBe(false);
  });

  it("does not treat a direct server's own pages as a relay sign-in", () => {
    expect(
      isRelaySignInRedirect(
        "https://app.example.invalid/relay/authorize?host=app.example.invalid",
        "https://app.example.invalid",
      ),
    ).toBe(false);
    expect(isRelaySignInRedirect("not a url", RELAY)).toBe(false);
  });
});

describe("decideShellNavigation", () => {
  const relay = {
    mode: "connect" as const,
    serverUrl: "https://alexb.omnyo.link",
  };

  const authorize =
    "https://omnyo.link/relay/authorize?host=alexb.omnyo.link&return=%2F";

  it("keeps the relay's top-frame sign-in redirect in the app as an auth failure", () => {
    expect(
      decideShellNavigation({ url: authorize, isTopFrame: true }, relay),
    ).toBe("relay-sign-in");
  });

  it("blocks a frame inside the page from reaching the relay sign-in without reporting it", () => {
    expect(
      decideShellNavigation({ url: authorize, isTopFrame: false }, relay),
    ).toBe("block");
  });

  it("loads the server's own pages and sends other web pages to the browser", () => {
    expect(
      decideShellNavigation(
        { url: "https://alexb.omnyo.link/threads/thr_1", isTopFrame: true },
        relay,
      ),
    ).toBe("load");
    expect(
      decideShellNavigation(
        { url: "https://example.com/docs", isTopFrame: true },
        relay,
      ),
    ).toBe("open-external");
    expect(
      decideShellNavigation(
        { url: "javascript:alert(1)", isTopFrame: true },
        relay,
      ),
    ).toBe("block");
  });

  it("never treats a relay URL as a sign-in for a direct server", () => {
    expect(
      decideShellNavigation(
        { url: authorize, isTopFrame: true },
        { mode: "direct", serverUrl: "https://app.example.invalid" },
      ),
    ).toBe("open-external");
  });
});

function passesWebViewWhitelist(url: string, whitelist: readonly string[]) {
  const origin = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url)?.[0] ?? "";

  return ["about:blank", ...whitelist].some((pattern) =>
    new RegExp(
      `^${pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*")}`,
    ).test(origin),
  );
}

describe("inline frames in the shell", () => {
  const direct = {
    mode: "direct" as const,
    serverUrl: "https://app.example.invalid",
  };

  const frames = [
    "about:srcdoc",
    "blob:https://app.example.invalid/1",
    "data:text/html,<p>x</p>",
  ];

  it("loads about:, blob: and data: subframes", () => {
    for (const url of frames) {
      expect(decideShellNavigation({ url, isTopFrame: false }, direct)).toBe(
        "load",
      );
    }
  });

  it("still blocks top-level navigations to about: and data: pages", () => {
    for (const url of ["about:srcdoc", "data:text/html,<p>x</p>"]) {
      expect(decideShellNavigation({ url, isTopFrame: true }, direct)).toBe(
        "block",
      );
    }
  });

  it("still sends cross-origin web frames to the browser", () => {
    expect(
      decideShellNavigation(
        { url: "https://example.com/embed", isTopFrame: false },
        direct,
      ),
    ).toBe("open-external");
  });

  it("lets every inline frame reach the shell's navigation handler", () => {
    for (const url of [...frames, "https://app.example.invalid/api/v1/x"]) {
      expect(passesWebViewWhitelist(url, SHELL_ORIGIN_WHITELIST)).toBe(true);
    }
  });
});
