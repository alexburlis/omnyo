import { z } from "zod";

export const legacyInstalledRuntimeVersionV1Schema = z.enum([
  "0.46.238+private.1",
  "0.46.241+private.1",
  "0.46.242+private.1",
  "0.46.245+private.1",
]);

export const LEGACY_INSTALLED_RUNTIME_V1 = {
  packageName: "bb-app",
  version: "0.46.238+private.1",
} as const;

export const legacyWorkerPackageRoleV1 = {
  files: ["dist", "host-daemon", "README.md"],
  bin: {
    bb: "dist/bb.js",
    "bb-app": "dist/bb-app.js",
    "bb-host-daemon": "dist/bb-host-daemon.js",
  },
} as const;

export const legacyFullPackageRoleV1 = {
  files: [
    "app/dist",
    "dist",
    "host-daemon/dist/bb",
    "host-daemon/dist/bb.cmd",
    "host-daemon/dist/bb-chunks",
    "host-daemon/dist/bb-file-search-worker.mjs",
    "host-daemon/dist/bb-parcel-watcher-child.mjs",
    "host-daemon/dist/bb-plugin-host-worker.mjs",
    "host-daemon/dist/bb-process-launcher-worker.mjs",
    "host-daemon/dist/bb-provider-bridge-worker.mjs",
    "host-daemon/dist/bb-workspace-observer-child.mjs",
    "host-daemon/dist/bb-workspace-read-child.mjs",
    "host-daemon/dist/daemon-bundle.mjs",
    "server/dist",
    "README.md",
    "!**/*.map",
  ],
  bin: {
    "bb-app": "dist/bb-app.js",
    bb: "dist/bb.js",
    "bb-server": "dist/bb-server.js",
    "bb-host-daemon": "dist/bb-host-daemon.js",
  },
} as const;
