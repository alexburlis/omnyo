#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const preferred =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["iPhone 17 Pro", "iPhone 17", "iPhone 16 Pro", "iPhone 16"];

const listing = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
  }),
);

function runtimeVersion(runtimeId) {
  const match = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtimeId);

  return match ? [Number(match[1]), Number(match[2])] : null;
}

const runtimes = Object.entries(listing.devices)
  .map(([runtimeId, devices]) => ({
    runtimeId,
    version: runtimeVersion(runtimeId),
    devices,
  }))
  .filter((entry) => entry.version !== null)
  .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);

let pick = null;

for (const name of preferred) {
  for (const runtime of runtimes) {
    const device = runtime.devices.find(
      (candidate) => candidate.name === name && candidate.isAvailable !== false,
    );

    if (device) {
      pick = { device, runtime };
      break;
    }
  }

  if (pick) break;
}

if (!pick) {
  for (const runtime of runtimes) {
    const device = runtime.devices.find(
      (candidate) =>
        candidate.name.startsWith("iPhone") && candidate.isAvailable !== false,
    );

    if (device) {
      pick = { device, runtime };
      break;
    }
  }
}

if (!pick) {
  console.error("No available iPhone simulator found");
  process.exit(1);
}

console.error(
  `Simulator: ${pick.device.name} (${pick.runtime.runtimeId}) ${pick.device.udid}`,
);

process.stdout.write(`${pick.device.udid}\n`);
