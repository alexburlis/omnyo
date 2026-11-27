import { chmod, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../native/OmnyoLocalVoice", import.meta.url));

const destination = fileURLToPath(new URL("../dist/local-voice-native/", import.meta.url));

const binary = await lstat(helper);

if (
  !binary.isFile() ||
  binary.isSymbolicLink() ||
  (process.platform !== "win32" && !(binary.mode & 0o111))
)
  throw new Error("native/OmnyoLocalVoice is missing. Run pnpm build:helper.");

await rm(destination, { recursive: true, force: true });

await mkdir(destination, { recursive: true });

await copyFile(helper, join(destination, "OmnyoLocalVoice"));

await chmod(join(destination, "OmnyoLocalVoice"), 0o755);
