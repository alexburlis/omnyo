const { createHash } = require("node:crypto");

const { readFile, writeFile } = require("node:fs/promises");

const { join } = require("node:path");

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return;

  const path = join(
    context.appOutDir,
    "resources",
    "private-update-identity.json",
  );

  const identity = JSON.parse(await readFile(path, "utf8"));

  if (
    identity.appId !== context.packager.appInfo.id ||
    !/^[A-Za-z0-9 ._-]+\.exe$/.test(identity.executable)
  )
    throw new Error("Private Windows signing identity differs");
  identity.executableSha256 = createHash("sha256")
    .update(await readFile(join(context.appOutDir, identity.executable)))
    .digest("hex");
  await writeFile(path, JSON.stringify(identity) + "\n", { mode: 0o644 });
};
