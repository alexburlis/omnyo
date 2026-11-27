import { createDesktopReleaseConfig } from "./desktop-release-channel.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { stringify } from "yaml";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  inspectDownloadedPrivateUpdate,
  inspectInstalledPrivateUpdate,
  verifyPrivateUpdateArchiveMatchesApp,
} from "../src/private-update-artifact.js";
import {
  PRIVATE_UPDATE_TEAM_ID,
  type PrivateReleaseInfo,
} from "../src/private-update-config.js";

const args = process.argv.slice(2);

let gate = "arguments";

function argument(name: string): string {
  const position = args.indexOf(name);
  const value = args[position + 1];

  if (position < 0 || value === undefined)
    throw new Error("Required public feed producer argument is missing");

  return value;
}

try {
  const appRoot = resolve(argument("--app"));
  const file = resolve(argument("--zip"));
  const output = resolve(argument("--output"));

  if (
    argument("--channel") !== "public-beta" ||
    output === file ||
    output.startsWith(appRoot + "/") ||
    basename(output) !== "public-beta-mac.yml"
  )
    throw new Error();

  const expectedAppId = createDesktopReleaseConfig(
    "public-beta",
    "macos",
  ).appId;

  gate = "installed identity";

  const installed = await inspectInstalledPrivateUpdate(appRoot);

  if (
    installed.appId !== expectedAppId ||
    installed.teamId !== PRIVATE_UPDATE_TEAM_ID ||
    installed.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
  )
    throw new Error();
  gate = "archive binding";

  await verifyPrivateUpdateArchiveMatchesApp(file, appRoot);
  const hash = createHash("sha512");

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  const release: PrivateReleaseInfo = {
    version: installed.version,
    releaseDate: new Date().toISOString(),
    files: [
      {
        url: basename(file),
        sha512: hash.digest("base64"),
        size: (await stat(file)).size,
      },
    ],
    omnyoPrivate: {
      appId: installed.appId,
      teamId: PRIVATE_UPDATE_TEAM_ID,
      runtimeVersion: installed.runtimeVersion,
      protocolVersion: installed.protocolVersion,
    },
  };

  await inspectDownloadedPrivateUpdate({
    file,
    release,
    currentVersion: "0.0.0",
    expectedAppId,
    expectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
  });
  gate = "output creation";
  await writeFile(output, stringify(release, { schema: "yaml-1.1" }), {
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(
    "Verified public feed metadata written locally; publication remains disabled.\n",
  );
} catch (error) {
  const cause = error instanceof Error ? (error.cause ?? error) : error;

  const detail =
    cause instanceof Error
      ? cause.message || cause.stack?.split("\n")[1]?.trim() || cause.name
      : String(cause);

  process.stderr.write(
    `Public feed production failed at ${gate}; no release was published.\n`,
  );
  process.stderr.write(`Cause: ${detail}\n`);
  process.exitCode = 1;
}
