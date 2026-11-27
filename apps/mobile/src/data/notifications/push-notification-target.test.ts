import { describe, expect, it, vi } from "vitest";
import {
  parsePushNotificationData,
  resolvePushTargetProfile,
  type PushTargetProfile,
  type ThreadProbe,
} from "./push-notification-target";

const sawyer: PushTargetProfile = {
  id: "p1",
  mode: "direct",
  serverUrl: "https://sawyer.example.test",
};

const lan: PushTargetProfile = {
  id: "p2",
  mode: "direct",
  serverUrl: "http://192.168.1.20:3000",
};

const tailnet: PushTargetProfile = {
  id: "p4",
  mode: "direct",
  serverUrl: "https://app.omnyohq.com",
};

const relay: PushTargetProfile = {
  id: "p5",
  mode: "connect",
  serverUrl: "https://alexb.omnyo.link",
};

describe("parsePushNotificationData", () => {
  it("reads the thread id and optional project / server hints", () => {
    expect(
      parsePushNotificationData({ threadId: "thr_1", projectId: "prj_1" }),
    ).toEqual({ threadId: "thr_1", projectId: "prj_1", serverUrl: null });
    expect(
      parsePushNotificationData({
        threadId: "thr_1",
        url: "https://sawyer.example.test/threads/thr_1",
        extra: 1,
      }),
    ).toEqual({
      threadId: "thr_1",
      projectId: null,
      serverUrl: "https://sawyer.example.test",
    });
    expect(
      parsePushNotificationData({
        threadId: "thr_1",
        serverUrl: "https://home.example.com/omnyo/",
      }),
    ).toEqual({
      threadId: "thr_1",
      projectId: null,
      serverUrl: "https://home.example.com/omnyo",
    });
  });

  it("rejects payloads without a thread id", () => {
    expect(parsePushNotificationData({ projectId: "p" })).toBeNull();
    expect(parsePushNotificationData("nope")).toBeNull();
    expect(parsePushNotificationData(undefined)).toBeNull();
  });
});

describe("resolvePushTargetProfile", () => {
  const target = { threadId: "thr_1", projectId: null, serverUrl: null };

  it("uses the server hint when it names a saved profile", async () => {
    const probeThread = vi.fn(async (): Promise<ThreadProbe> => "missing");
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "http://192.168.1.20:3000" },
        { profiles: [sawyer, lan], activeProfileId: "p1", probeThread },
      ),
    ).toBe(lan);
    expect(probeThread).not.toHaveBeenCalled();
  });

  it("matches a server hint with a saved path prefix", async () => {
    const prefixed: PushTargetProfile = {
      id: "p3",
      mode: "direct",
      serverUrl: "https://home.example.com/omnyo",
    };

    const probeThread = vi.fn(async (): Promise<ThreadProbe> => "missing");
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://home.example.com/omnyo" },
        { profiles: [sawyer, prefixed], activeProfileId: "p1", probeThread },
      ),
    ).toBe(prefixed);
    expect(probeThread).not.toHaveBeenCalled();
  });

  it("probes the only profile when no server hint matches", async () => {
    const probeThread = vi.fn(async (): Promise<ThreadProbe> => "found");
    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer],
        activeProfileId: null,
        probeThread,
      }),
    ).toBe(sawyer);
    expect(probeThread).toHaveBeenCalledWith(sawyer.serverUrl, "thr_1");
  });

  it("probes profiles when a server hint does not match", async () => {
    const probeThread = vi.fn(
      async (serverUrl: string): Promise<ThreadProbe> =>
        serverUrl === lan.serverUrl ? "found" : "missing",
    );

    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://unknown.example" },
        { profiles: [sawyer, lan], activeProfileId: "p1", probeThread },
      ),
    ).toBe(lan);
    expect(probeThread).toHaveBeenCalledTimes(2);
  });

  it("probes the active profile first, then the others, tolerating failures", async () => {
    const probeThread = vi.fn(
      async (serverUrl: string): Promise<ThreadProbe> => {
        if (serverUrl === lan.serverUrl) throw new Error("offline");

        return serverUrl === sawyer.serverUrl ? "found" : "missing";
      },
    );

    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer, lan],
        activeProfileId: "p2",
        probeThread,
      }),
    ).toBe(sawyer);
    expect(probeThread.mock.calls.map(([url]) => url)).toEqual([
      lan.serverUrl,
      sawyer.serverUrl,
    ]);
  });

  it("keeps the active relay route when it has the thread the coordinator's own URL names", async () => {
    const probeThread = vi.fn(
      async (serverUrl: string): Promise<ThreadProbe> =>
        serverUrl === relay.serverUrl ? "found" : "missing",
    );

    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://app.omnyohq.com" },
        { profiles: [tailnet, relay], activeProfileId: "p5", probeThread },
      ),
    ).toBe(relay);
    expect(probeThread).toHaveBeenCalledExactlyOnceWith(
      relay.serverUrl,
      "thr_1",
    );
  });

  it("opens the hinted server only when the active relay route answers that the thread is missing", async () => {
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://app.omnyohq.com" },
        {
          profiles: [tailnet, relay],
          activeProfileId: "p5",
          probeThread: async () => "missing",
        },
      ),
    ).toBe(tailnet);
  });

  it("stays on the active relay route when its probe is refused, fails or times out", async () => {
    const hint = { ...target, serverUrl: "https://app.omnyohq.com" };

    const timeout = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });

    for (const probeThread of [
      async (): Promise<ThreadProbe> => "unknown",
      async (): Promise<ThreadProbe> => {
        throw new Error("offline");
      },
      async (): Promise<ThreadProbe> => {
        throw timeout;
      },
    ]) {
      expect(
        await resolvePushTargetProfile(hint, {
          profiles: [tailnet, relay],
          activeProfileId: "p5",
          probeThread,
        }),
      ).toBe(relay);
    }
  });

  it("does not probe when the hinted server is the active one", async () => {
    const probeThread = vi.fn(async (): Promise<ThreadProbe> => "found");
    expect(
      await resolvePushTargetProfile(
        { ...target, serverUrl: "https://app.omnyohq.com" },
        { profiles: [tailnet, relay], activeProfileId: "p4", probeThread },
      ),
    ).toBe(tailnet);
    expect(probeThread).not.toHaveBeenCalled();
  });

  it("gives up when no server has the thread", async () => {
    expect(
      await resolvePushTargetProfile(target, {
        profiles: [sawyer, lan],
        activeProfileId: "p1",
        probeThread: async () => "missing",
      }),
    ).toBeNull();
  });
});

it("routes queued old-domain notifications to the migrated profile without probing the retired host", async () => {
  const target = parsePushNotificationData({
    threadId: "thr_original",
    serverUrl: "https://alexb.slashnew.com",
  });

  expect(target).toEqual({
    threadId: "thr_original",
    projectId: null,
    serverUrl: relay.serverUrl,
  });
  const probeThread = vi.fn(async (): Promise<ThreadProbe> => "missing");

  if (target === null) throw new Error("Notification target was not parsed");
  expect(
    await resolvePushTargetProfile(target, {
      profiles: [relay],
      activeProfileId: relay.id,
      probeThread,
    }),
  ).toBe(relay);
  expect(probeThread).not.toHaveBeenCalled();
});
