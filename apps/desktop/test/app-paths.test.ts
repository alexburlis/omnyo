import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopMachineInstallerPath,
  type DesktopPathContext,
} from "../src/app-paths.js";

describe("desktop app paths", () => {
  it("resolves the packaged omnyo-app bridge beside the active asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Omnyo.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Omnyo.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      normalize(
        "/Applications/Omnyo.app/Contents/Resources/app.asar.unpacked/dist/omnyo-app-bridge.mjs",
      ),
    );
  });

  it("resolves the universal packaged omnyo-app bridge beside the selected arch asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Omnyo.app/Contents/Resources/app-arm64.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Omnyo.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      normalize(
        "/Applications/Omnyo.app/Contents/Resources/app-arm64.asar.unpacked/dist/omnyo-app-bridge.mjs",
      ),
    );
  });

  it("resolves the machine installer inside the omnyo-app package beside the bridge", () => {
    expect(
      resolveDesktopMachineInstallerPath(
        "/Applications/Omnyo.app/Contents/Resources/app.asar.unpacked/dist/omnyo-app-bridge.mjs",
      ),
    ).toBe(
      normalize(
        "/Applications/Omnyo.app/Contents/Resources/app.asar.unpacked/node_modules/omnyo-app/server/dist/assets/install-machine.sh",
      ),
    );
  });

  it("uses the release-specific icon inside packaged apps", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Omnyo Nightly.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Omnyo Nightly.app/Contents/Resources",
    };

    expect(
      resolveDesktopIconPath({
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe(
      normalize(
        "/Applications/Omnyo Nightly.app/Contents/Resources/app.asar/assets/icon-nightly.png",
      ),
    );
  });

  it("keeps the development icon independent of the release channel", () => {
    const paths: DesktopPathContext = {
      appPath: "/checkout/apps/desktop",
      isPackaged: false,
      resourcesPath: "/checkout/apps/desktop",
    };

    expect(
      resolveDesktopIconPath({
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe(normalize("/checkout/apps/desktop/assets/icon-dev.png"));
  });
});
