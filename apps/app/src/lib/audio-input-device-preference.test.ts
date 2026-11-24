import { migrateLegacyBrowserStorageV1 } from "./legacy-browser-storage-v1";
import { describe, expect, it, vi } from "vitest";
import {
  buildAudioInputConstraints,
  parsePreferredAudioInputDeviceId,
  requestAudioInputStream,
} from "./audio-input-device-preference";

describe("audio input device preference", () => {
  it("parses only non-empty stored device ids", () => {
    expect(parsePreferredAudioInputDeviceId(null, null)).toBeNull();
    expect(parsePreferredAudioInputDeviceId("", null)).toBeNull();
    expect(parsePreferredAudioInputDeviceId("   ", null)).toBeNull();
    expect(parsePreferredAudioInputDeviceId("studio-mic", null)).toBe(
      "studio-mic",
    );
  });

  it("builds default and exact-device getUserMedia constraints", () => {
    expect(buildAudioInputConstraints(null)).toEqual({ audio: true });
    expect(buildAudioInputConstraints("studio-mic")).toEqual({
      audio: { deviceId: { exact: "studio-mic" } },
    });
  });
});

describe("requestAudioInputStream", () => {
  const stream = { id: "recording" };

  it("uses the preferred device without retrying when it is available", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    await expect(
      requestAudioInputStream(
        { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
        "headphones",
      ),
    ).resolves.toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([
      [{ audio: { deviceId: { exact: "headphones" } } }],
    ]);
  });

  it.each([
    "OverconstrainedError",
    "NotFoundError",
    "DevicesNotFoundError",
    "NotReadableError",
  ])("falls back after %s", async (name) => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Missing device", name))
      .mockResolvedValueOnce(stream);

    await expect(
      requestAudioInputStream(
        { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
        "headphones",
      ),
    ).resolves.toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([
      [{ audio: { deviceId: { exact: "headphones" } } }],
      [{ audio: true }],
    ]);
  });

  it.each(["NotAllowedError", "SecurityError", "AbortError"])(
    "does not retry %s",
    async (name) => {
      const error = new DOMException("Capture failed", name);
      const getUserMedia = vi.fn().mockRejectedValue(error);
      await expect(
        requestAudioInputStream(
          { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
          "headphones",
        ),
      ).rejects.toBe(error);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a fallback failure when no microphone is available", async () => {
    const error = new DOMException("No microphones", "NotFoundError");

    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("Disconnected", "OverconstrainedError"),
      )
      .mockRejectedValueOnce(error);

    await expect(
      requestAudioInputStream(
        { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
        "headphones",
      ),
    ).rejects.toBe(error);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unavailable system default", async () => {
    const error = new DOMException("No microphones", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(error);
    await expect(
      requestAudioInputStream(
        { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
        null,
      ),
    ).rejects.toBe(error);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: true }]]);
  });
});

it("tries another input when both the preferred and system-default microphones cannot start", async () => {
  const stream = { id: "working-external" };

  const getUserMedia = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Busy", "NotReadableError"))
    .mockRejectedValueOnce(new DOMException("Unavailable", "NotReadableError"))
    .mockResolvedValueOnce(stream);

  const enumerateDevices = vi.fn().mockResolvedValue([
    { kind: "audioinput", deviceId: "built-in" },
    { kind: "audioinput", deviceId: "default" },
    { kind: "audioinput", deviceId: "external" },
  ]);

  await expect(
    requestAudioInputStream({ getUserMedia, enumerateDevices }, "built-in"),
  ).resolves.toBe(stream);
  expect(getUserMedia.mock.calls).toEqual([
    [{ audio: { deviceId: { exact: "built-in" } } }],
    [{ audio: true }],
    [{ audio: { deviceId: { exact: "external" } } }],
  ]);
});

function preferenceStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("audio preference finite V1 admission", () => {
  const legacyKeyV1 = "bb.voiceInput.audioInputDeviceId";
  const canonicalKey = "omnyo.voiceInput.audioInputDeviceId";

  it.each(["  bb.user-mic  ", ""])(
    "preserves exact selected raw value %j",
    (raw) => {
      const local = preferenceStorage();
      const session = preferenceStorage();
      local.setItem(legacyKeyV1, raw);
      migrateLegacyBrowserStorageV1({ local, session });
      expect(local.getItem(canonicalKey)).toBe(raw);
      expect(local.getItem(legacyKeyV1)).toBeNull();
      expect(
        parsePreferredAudioInputDeviceId(local.getItem(canonicalKey), null),
      ).toBe(raw === "" ? null : raw);
    },
  );

  it("leaves missing selection absent and does not create a default choice", () => {
    const local = preferenceStorage();
    const session = preferenceStorage();
    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });

  it("refuses unequal audio authorities before touching opaque storage", () => {
    const local = preferenceStorage();
    const session = preferenceStorage();
    local.setItem(legacyKeyV1, "old-mic");
    local.setItem(canonicalKey, "current-mic");
    local.setItem("user.raw", "bb user bytes remain unchanged");
    expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(
      /conflict/iu,
    );
    expect(local.getItem(legacyKeyV1)).toBe("old-mic");
    expect(local.getItem(canonicalKey)).toBe("current-mic");
    expect(local.getItem("user.raw")).toBe("bb user bytes remain unchanged");
  });

  it("preserves the old selection on quota refusal and resumes without replay", () => {
    const local = preferenceStorage();
    const session = preferenceStorage();
    local.setItem(legacyKeyV1, "selected-mic");
    const original = local.setItem;

    const failure = vi
      .spyOn(local, "setItem")
      .mockImplementation((key, value) => {
        if (key === canonicalKey)
          throw new DOMException("fixture quota", "QuotaExceededError");
        original(key, value);
      });

    try {
      expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(
        /quota/iu,
      );
      expect(local.getItem(legacyKeyV1)).toBe("selected-mic");
      expect(local.getItem(canonicalKey)).toBeNull();
    } finally {
      failure.mockRestore();
    }

    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem(canonicalKey)).toBe("selected-mic");
    expect(local.getItem(legacyKeyV1)).toBeNull();
    const writes = vi.spyOn(local, "setItem");

    try {
      migrateLegacyBrowserStorageV1({ local, session });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
  });

  it("collapses matching selections without replacing their raw bytes", () => {
    const local = preferenceStorage();
    const session = preferenceStorage();
    const raw = "  exact-mic  ";
    local.setItem(legacyKeyV1, raw);
    local.setItem(canonicalKey, raw);
    const writes = vi.spyOn(local, "setItem");

    try {
      migrateLegacyBrowserStorageV1({ local, session });
      expect(writes).not.toHaveBeenCalled();
      expect(local.getItem(legacyKeyV1)).toBeNull();
      expect(local.getItem(canonicalKey)).toBe(raw);
    } finally {
      writes.mockRestore();
    }
  });

  it("keeps Later and audio originals until every preference copy verifies", () => {
    const local = preferenceStorage();
    const session = preferenceStorage();
    local.setItem("bb.desktopUpdateLaterVersion", "0.46.242+private.1");
    local.setItem(legacyKeyV1, "selected-mic");
    const original = local.setItem;

    const failure = vi
      .spyOn(local, "setItem")
      .mockImplementation((key, value) => {
        if (key === canonicalKey)
          throw new DOMException("fixture quota", "QuotaExceededError");
        original(key, value);
      });

    try {
      expect(() => migrateLegacyBrowserStorageV1({ local, session })).toThrow(
        /quota/iu,
      );
      expect(local.getItem("bb.desktopUpdateLaterVersion")).toBe(
        "0.46.242+private.1",
      );
      expect(local.getItem(legacyKeyV1)).toBe("selected-mic");
    } finally {
      failure.mockRestore();
    }

    migrateLegacyBrowserStorageV1({ local, session });
    expect(local.getItem("omnyo.desktopUpdateLaterVersion")).toBe(
      "0.46.242+private.1",
    );
    expect(local.getItem(canonicalKey)).toBe("selected-mic");
    expect(local.getItem("bb.desktopUpdateLaterVersion")).toBeNull();
    expect(local.getItem(legacyKeyV1)).toBeNull();
  });
});
