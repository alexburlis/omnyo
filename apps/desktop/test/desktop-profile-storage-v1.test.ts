import { describe, expect, it } from "vitest";
import { initializeDesktopProfileStorageV1 } from "../src/desktop-profile-storage-v1.js";

function harness(available: boolean) {
  const events: string[] = [];

  return {
    events,
    input: {
      encryption: {
        isEncryptionAvailable: () => available,
        encryptString(value: string) {
          events.push("encrypt");

          return Buffer.from(value);
        },
      },
      async initializeCookies() {
        events.push("cookies");
      },
      setDisplayName(value: string) {
        events.push("name:" + value);
      },
    },
  };
}

describe("desktop profile storage owner", () => {
  it("locks the Omnyo Private protected store before showing Omnyo", async () => {
    const { events, input } = harness(true);

    await initializeDesktopProfileStorageV1({
      ...input,
      storageName: "Omnyo Private",
      applicationName: "Omnyo",
    });

    expect(events).toEqual(["encrypt", "cookies", "name:Omnyo"]);
  });

  it("keeps the storage name when the protected store is unavailable", async () => {
    const { events, input } = harness(false);

    await expect(
      initializeDesktopProfileStorageV1({
        ...input,
        storageName: "Omnyo Private",
        applicationName: "Omnyo",
      }),
    ).rejects.toThrow("protected store is unavailable");
    expect(events).toEqual([]);
  });

  it("changes nothing when the display and storage names match", async () => {
    const { events, input } = harness(true);

    await initializeDesktopProfileStorageV1({
      ...input,
      storageName: "omnyo-dev",
      applicationName: "omnyo-dev",
    });

    expect(events).toEqual([]);
  });
});
