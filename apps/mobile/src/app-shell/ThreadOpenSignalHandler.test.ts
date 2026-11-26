import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/settings/device",
  push: vi.fn(),
  onThreadOpen: vi.fn(),
}));

vi.mock("expo-router", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => effect(),
}));

vi.mock("./ProfilesProvider", () => ({
  useProfiles: () => ({
    connection: {
      profile: { id: "profile-origin" },
      client: { realtime: { onThreadOpen: mocks.onThreadOpen } },
    },
  }),
}));

import { ThreadOpenSignalHandler } from "./ThreadOpenSignalHandler";

describe("ThreadOpenSignalHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/settings/device";
  });

  it("lets the visible WebView handle realtime opens without native navigation", () => {
    mocks.pathname = "/webview";
    ThreadOpenSignalHandler();
    expect(mocks.onThreadOpen).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("brings a thread forward from native settings using the originating server", () => {
    ThreadOpenSignalHandler();
    const open = mocks.onThreadOpen.mock.calls[0]?.[0];
    expect(open).toBeTypeOf("function");
    open({ threadId: "thr_requested" });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/webview",
      params: { profileId: "profile-origin", path: "/threads/thr_requested" },
    });
  });
});
