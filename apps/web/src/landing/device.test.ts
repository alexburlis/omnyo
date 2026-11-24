import { describe, expect, it } from "vitest";

import { DEVICE_SCRIPT, detectDevice } from "./device";

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

describe("detectDevice", () => {
  it("separates an iPad that reports a Mac user agent from a Mac", () => {
    expect(detectDevice({ userAgent: MAC, maxTouchPoints: 0 })).toEqual({
      os: "mac",
      form: "desktop",
    });

    expect(detectDevice({ userAgent: MAC, maxTouchPoints: 5 })).toEqual({
      os: "ios",
      form: "tablet",
    });
  });

  it("treats a wide or segmented phone as a foldable", () => {
    expect(detectDevice({ userAgent: IPHONE, shortSide: 393 }).form).toBe(
      "phone",
    );

    expect(detectDevice({ userAgent: IPHONE, shortSide: 720 }).form).toBe(
      "foldable",
    );

    expect(
      detectDevice({ userAgent: ANDROID_PHONE, shortSide: 412, segments: 2 })
        .form,
    ).toBe("foldable");
  });

  it("tells Android phones from tablets", () => {
    expect(detectDevice({ userAgent: ANDROID_PHONE, shortSide: 412 })).toEqual({
      os: "android",
      form: "phone",
    });

    expect(detectDevice({ userAgent: ANDROID_TABLET, shortSide: 800 })).toEqual(
      { os: "android", form: "tablet" },
    );
  });

  it("does not mistake Android for Linux or guess an unknown system", () => {
    expect(detectDevice({ userAgent: WINDOWS }).os).toBe("windows");
    expect(detectDevice({ userAgent: LINUX }).os).toBe("linux");
    expect(detectDevice({ userAgent: "" }).os).toBe("unknown");
  });
});

describe("DEVICE_SCRIPT", () => {
  const run = (navigator: object, screen: object) => {
    const dataset: Record<string, string> = {};

    new Function("navigator", "screen", "window", "document", DEVICE_SCRIPT)(
      navigator,
      screen,
      { visualViewport: null },
      { documentElement: { dataset } },
    );

    return dataset;
  };

  it("agrees with detectDevice for each system", () => {
    const cases = [
      { userAgent: MAC, maxTouchPoints: 0, shortSide: 900 },
      { userAgent: MAC, maxTouchPoints: 5, shortSide: 820 },
      { userAgent: IPHONE, maxTouchPoints: 5, shortSide: 393 },
      { userAgent: IPHONE, maxTouchPoints: 5, shortSide: 720 },
      { userAgent: ANDROID_PHONE, maxTouchPoints: 5, shortSide: 412 },
      { userAgent: ANDROID_TABLET, maxTouchPoints: 5, shortSide: 800 },
      { userAgent: WINDOWS, maxTouchPoints: 0, shortSide: 1080 },
      { userAgent: LINUX, maxTouchPoints: 0, shortSide: 1080 },
    ];

    for (const entry of cases) {
      const expected = detectDevice(entry);

      expect(
        run(
          { userAgent: entry.userAgent, maxTouchPoints: entry.maxTouchPoints },
          { width: entry.shortSide, height: entry.shortSide * 2 },
        ),
      ).toEqual({ os: expected.os, form: expected.form });
    }
  });
});
